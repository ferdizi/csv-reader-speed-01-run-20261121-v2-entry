// csv-reader v2 — a faster drop-in for csv-reader 1.0.0 (make.fun).
//
// Single-pass streaming parser. It reads the case input once, left to right,
// and emits the JSON text of the answer {columns, rows, errors} directly,
// without ever building the answer object graph or calling JSON.stringify
// on it. That removes the stringify round-trip (about a third of v1's cost)
// and the per-row / per-error object allocations.
//
// run(input) is defined through the same emitter (JSON.parse of the emitted
// text), so the two entry points agree by construction.
//
// Semantics (from RULES.txt): a U+FEFF at the very start is dropped. A
// record ends at LF or CRLF; a line left with no characters is no record.
// Outside quotes a CR not followed by LF is dropped (error stray_cr). A
// field that opens with a quote runs to the next quote that is not doubled
// ("" inside it is one quote, each CRLF or lone CR inside it reads as LF);
// what follows its closing quote, up to the next comma or line break, is
// appended as it stands (quote_junk, when the field ends); a quote that
// never closes is a literal character and the text after it is read again
// as unquoted (unterminated_quote). A quote inside an unquoted field is a
// literal character. Fields stay strings, never trimmed or converted.
// columns is the first record when header is true, else null; rows holds
// the records after it, each padded with "" (short_row, with fields: its
// field count) or cut (long_row, with extra: the cut fields) to the first
// record's width. Each error is {code, line, row}, in the order met; line
// is the 1-based line its record starts on, counting every LF, CRLF and
// lone CR inside quotes, and row is its record's index in rows, null for
// the header. A short_row / long_row is recorded when its record ends.

const BOM = 0xfeff;
const COMMA = 44;
const LF = 10;
const CR = 13;
const QUOTE = 34;
const BACKSLASH = 92;

// Escape a string value exactly the way JSON.stringify does. Only called
// when the value is already known to contain a character that needs it.
function escJson(v) {
  let out = '';
  let start = 0;
  for (let k = 0; k < v.length; k++) {
    const c = v.charCodeAt(k);
    let rep = '';
    if (c === 34) rep = '\\"';
    else if (c === 92) rep = '\\\\';
    else if (c === 8) rep = '\\b';
    else if (c === 9) rep = '\\t';
    else if (c === 10) rep = '\\n';
    else if (c === 12) rep = '\\f';
    else if (c === 13) rep = '\\r';
    else if (c < 32) rep = '\\u' + c.toString(16).padStart(4, '0');
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = k + 1 < v.length ? v.charCodeAt(k + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        k++;
        continue;
      } // valid pair: both halves pass through raw
      rep = '\\u' + c.toString(16).padStart(4, '0');
    } else if (c >= 0xdc00 && c <= 0xdfff) rep = '\\u' + c.toString(16).padStart(4, '0');
    else continue;
    out += v.slice(start, k) + rep;
    start = k + 1;
  }
  return out + v.slice(start);
}

// Emit the JSON text of the answer for one case input {text, header}.
// Field end kinds: 0 = comma, 1 = LF, 2 = CRLF, 3 = EOF.
export function runToJson(input) {
  const s = input.text;
  const header = !!input.header;
  const n = s.length;
  let i = 0;
  if (n > 0 && s.charCodeAt(0) === BOM) i = 1;
  let line = 1;
  let width = -1;
  let rowIdx = 0;
  let first = true;
  // With header=true and no records at all, columns is [] (not null).
  let cols = header ? '[]' : 'null';
  let rowsOut = '';
  let rowsSep = '';
  let errOut = '';
  let errSep = '';
  let recLine = 1;
  let rowStr = 'null';
  const f = [];

  function emitErr(json) {
    errOut += errSep;
    errOut += json;
    errSep = ',';
  }

  // Scratch outputs for scanUnquoted / parseQuoted.
  let uqValue = '';
  let uqEsc = 0;
  let uqEnd = 3;
  let uqPos = 0;
  let uqDl = 0;

  // Read one unquoted stretch starting at `start` (a field body, the
  // re-read after an unterminated quote, or the junk after a closing
  // quote). `pfx` is prepended to the value (the literal opening quote
  // of an unterminated field); `pesc` is its escape flag. A lone CR is
  // dropped with a stray_cr error and the field continues; a comma ends
  // the field, LF / CRLF ends the record, EOF ends both.
  function scanUnquoted(start, pfx, pesc) {
    let j = start;
    let parts = null;
    let seg = start;
    let esc = pesc;
    let ek = 3;
    let ep = n;
    for (;;) {
      while (j < n) {
        const c = s.charCodeAt(j);
        if (c < 45) {
          if (c === COMMA || c === LF || c === CR) break;
          if (c < 32 || c === QUOTE) esc = 1;
        } else if (c === BACKSLASH || (c >= 0xd800 && c <= 0xdfff)) esc = 1;
        j++;
      }
      if (j >= n) {
        ek = 3;
        ep = n;
        break;
      }
      const c = s.charCodeAt(j);
      if (c === COMMA) {
        ek = 0;
        ep = j;
        break;
      }
      if (c === LF) {
        ek = 1;
        ep = j;
        break;
      }
      if (j + 1 < n && s.charCodeAt(j + 1) === LF) {
        ek = 2;
        ep = j;
        break;
      }
      emitErr('{"code":"stray_cr","line":' + recLine + ',"row":' + rowStr + '}');
      if (parts === null) parts = [];
      parts.push(s.slice(seg, j));
      j++;
      seg = j;
    }
    if (parts === null) uqValue = pfx + s.slice(start, j);
    else {
      parts.push(s.slice(seg, j));
      uqValue = pfx + parts.join('');
    }
    uqEsc = esc;
    uqEnd = ek;
    uqPos = ep;
  }

  // Parse a field that opens with a quote at `start`. Kept out of the
  // main loop so runToJson stays small and quick to optimise; quoted
  // fields are only ~15% of fields. Fills the uq* scratch vars (uqDl =
  // line breaks inside the quotes, committed by the caller only when
  // the quote really closes).
  function parseQuoted(start) {
    let j = start + 1;
    let parts = null;
    let seg = start + 1;
    let closePos = -1;
    let dl = 0;
    let esc = 0;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === QUOTE) {
        if (j + 1 < n && s.charCodeAt(j + 1) === QUOTE) {
          if (parts === null) parts = [];
          parts.push(s.slice(seg, j), '"');
          esc = 1;
          j += 2;
          seg = j;
          continue;
        }
        closePos = j;
        break;
      }
      if (c === CR) {
        if (parts === null) parts = [];
        parts.push(s.slice(seg, j), '\n');
        esc = 1;
        dl++;
        if (j + 1 < n && s.charCodeAt(j + 1) === LF) j += 2;
        else j++;
        seg = j;
        continue;
      }
      if (c === LF) {
        if (parts === null) parts = [];
        parts.push(s.slice(seg, j), '\n');
        esc = 1;
        dl++;
        j++;
        seg = j;
        continue;
      }
      if (c === BACKSLASH || c < 32 || (c >= 0xd800 && c <= 0xdfff)) esc = 1;
      j++;
    }
    if (closePos === -1) {
      // Unterminated: the quote is a literal character; read the text
      // after it again as unquoted.
      emitErr('{"code":"unterminated_quote","line":' + recLine + ',"row":' + rowStr + '}');
      scanUnquoted(start + 1, '"', 1);
      uqDl = 0;
      return;
    }
    uqDl = dl;
    let value;
    if (parts === null) value = s.slice(start + 1, closePos);
    else {
      parts.push(s.slice(seg, closePos));
      value = parts.join('');
    }
    // Junk after the closing quote, up to the next comma or line break,
    // is appended as it stands.
    scanUnquoted(closePos + 1, '', 0);
    if (uqValue.length > 0) {
      value += uqValue;
      esc |= uqEsc;
      emitErr('{"code":"quote_junk","line":' + recLine + ',"row":' + rowStr + '}');
    }
    uqValue = value;
    uqEsc = esc;
  }

  while (i < n) {
    // Skip blank lines (LF, or CRLF). A lone CR is NOT consumed here: it
    // belongs to the line's first field, whose quoted-or-not decision is
    // taken from its very first character — a field starting with a stray
    // CR is unquoted even when a quote follows the CR.
    for (;;) {
      if (i >= n) break;
      const c = s.charCodeAt(i);
      if (c === LF) {
        i++;
        line++;
        continue;
      }
      if (c === CR && i + 1 < n && s.charCodeAt(i + 1) === LF) {
        i += 2;
        line++;
        continue;
      }
      break;
    }
    if (i >= n) break;

    recLine = line;
    rowStr = first && header ? 'null' : '' + rowIdx;
    f.length = 0;
    // True once the record's raw span holds a character other than a
    // dropped stray CR: a quoted field, a comma, or a non-empty value.
    // A record with no such character (a line of stray CRs only) is no
    // record at all — its errors stand, but it takes no width, no row
    // index and no place in rows/columns.
    let recContent = false;

    // Fields of this record.
    for (;;) {
      let value = '';
      let esc = 0;
      let endKind;
      let endPos;

      if (i >= n) {
        // Empty field at EOF (trailing comma).
        endKind = 3;
        endPos = n;
      } else if (s.charCodeAt(i) === QUOTE) {
        // Quoted field: the opening quote itself is content.
        recContent = true;
        parseQuoted(i);
        value = uqValue;
        esc = uqEsc;
        endKind = uqEnd;
        endPos = uqPos;
        line += uqDl;
      } else {
        // Unquoted field, inlined hot path (no call): scan for the next
        // delimiter, dropping lone CRs with a stray_cr error.
        let j = i;
        let parts = null;
        let seg = i;
        while (true) {
          while (j < n) {
            const c = s.charCodeAt(j);
            if (c < 45) {
              if (c === COMMA || c === LF || c === CR) break;
              if (c < 32 || c === QUOTE) esc = 1;
            } else if (c === BACKSLASH || (c >= 0xd800 && c <= 0xdfff)) esc = 1;
            j++;
          }
          if (j >= n) {
            endKind = 3;
            endPos = n;
            break;
          }
          const c = s.charCodeAt(j);
          if (c === COMMA) {
            endKind = 0;
            endPos = j;
            break;
          }
          if (c === LF) {
            endKind = 1;
            endPos = j;
            break;
          }
          if (j + 1 < n && s.charCodeAt(j + 1) === LF) {
            endKind = 2;
            endPos = j;
            break;
          }
          emitErr('{"code":"stray_cr","line":' + recLine + ',"row":' + rowStr + '}');
          if (parts === null) parts = [];
          parts.push(s.slice(seg, j));
          j++;
          seg = j;
        }
        if (parts === null) value = s.slice(i, j);
        else {
          parts.push(s.slice(seg, j));
          value = parts.join('');
        }
      }

      if (value.length > 0) recContent = true;
      f.push(esc ? escJson(value) : value);
      if (endKind === 0) {
        i = endPos + 1;
        recContent = true;
        continue;
      }
      if (endKind === 1) {
        i = endPos + 1;
        line++;
      } else if (endKind === 2) {
        i = endPos + 2;
        line++;
      } else {
        i = endPos;
      }
      break;
    }

    // Record end: normalise to the first record's width. A record with
    // no content (a line of stray CRs only) is no record: keep its
    // errors, change nothing else.
    if (recContent) {
      const nf = f.length;
      if (first) {
        width = nf;
        if (header) {
          cols = '["' + f.join('","') + '"]';
        } else {
          rowsOut += rowsSep + '["' + f.join('","') + '"]';
          rowsSep = ',';
          rowIdx++;
        }
        first = false;
      } else if (nf === width) {
        rowsOut += rowsSep + '["' + f.join('","') + '"]';
        rowsSep = ',';
        rowIdx++;
      } else if (nf < width) {
        let rec = '["' + f.join('","') + '"';
        for (let k = nf; k < width; k++) rec += ',""';
        rec += ']';
        rowsOut += rowsSep + rec;
        rowsSep = ',';
        emitErr(
          '{"code":"short_row","line":' +
            recLine +
            ',"row":' +
            rowStr +
            ',"fields":' +
            nf +
            '}'
        );
        rowIdx++;
      } else {
        rowsOut += rowsSep + '["' + f.slice(0, width).join('","') + '"]';
        rowsSep = ',';
        emitErr(
          '{"code":"long_row","line":' +
            recLine +
            ',"row":' +
            rowStr +
            ',"extra":["' +
            f.slice(width).join('","') +
            '"]}'
        );
        rowIdx++;
      }
    }
  }

  return '{"columns":' + cols + ',"rows":[' + rowsOut + '],"errors":[' + errOut + ']}';
}

export function run(input) {
  return JSON.parse(runToJson(input));
}
