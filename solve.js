// FastCSV — a faster drop-in for csv-reader 1.0.0 (make.fun's own reference CSV
// reader). run(input) returns exactly what csv-reader 1.0.0 returns for
// {text, header}: {columns, rows, errors}.
//
// Written from the reference's stated policy (RULES.txt) and checked against
// its code, not copied from it: the reference walks one character at a time
// and builds every field a character at a time. This reader instead jumps
// with native indexOf/slice/split calls and only slows down where the input
// is actually broken:
//
//   - a record whose first line holds no quote is split in one native
//     split(',') call (the common case: plain numbers, dates, codes, words);
//   - an unquoted field is found with one indexOf(',') against the cached
//     end of its line, then sliced whole; a stray CR inside it is the rare
//     path that re-reads the slice;
//   - a quoted field finds its closing quote with indexOf('"') (doubled
//     quotes skipped), slices its content whole, and only touches a regex
//     when the content holds a line break or a doubled quote;
//   - a quote that never closes falls back to the reference's own rule:
//     the quote becomes a literal and the rest is re-read as unquoted.
//
// Every error the reference records is recorded here, in the same order,
// with the same {code, line, row} (and fields/extra for short/long rows).

/** How a field ended: at a comma, at a line break, at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // End of the line holding pos: the index of its '\n', or len; -1 when unknown.
  // Valid while pos stays on that line; any step onto a new line clears it.
  let le = -1;
  // Whether the line holding pos holds a stray CR: 1 yes, 0 no (a trailing
  // CR before its '\n' is the CRLF half, not stray), -1 when unknown.
  let lineCr = -1;

  function lineEnd() {
    if (le === -1) {
      le = text.indexOf('\n', pos);
      if (le === -1) le = len;
    }
    if (lineCr === -1) {
      const s = text.slice(pos, le);
      const r0 = s.indexOf('\r');
      lineCr = r0 !== -1 && (r0 !== s.length - 1 || le === len) ? 1 : 0;
    }
    return le;
  }

  function pushErr(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // The field slice `s` with its stray CRs dropped, one stray_cr error each.
  // When it ends at a line break, a trailing CR is the CRLF half, not stray.
  function stripStray(s, trailingCrOk) {
    let end = s.length;
    if (trailingCrOk && end > 0 && s.charCodeAt(end - 1) === 13) end -= 1;
    let n = 0;
    for (let k = 0; k < end; k++) if (s.charCodeAt(k) === 13) n++;
    for (let k = 0; k < n; k++) pushErr('stray_cr');
    if (n === 0) return end === s.length ? s : s.slice(0, end);
    return s.slice(0, end).replaceAll('\r', '');
  }

  // The result of one unquoted read, reused (never re-entered).
  const scanResult = { value: '', ended: END, added: 0 };

  // Reads unquoted characters from pos up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). `init` starts the field
  // ('' for a plain field, the quoted content for the junk after a closing
  // quote, '"' for the re-read of a quote that never closes); `added` counts
  // the characters this read kept.
  function scanUnquoted(init) {
    const e = lineEnd();
    const c = text.indexOf(',', pos);
    let f;
    let ended;
    if (c !== -1 && c < e) {
      f = text.slice(pos, c);
      pos = c + 1;
      ended = COMMA;
      if (lineCr === 1 && f.indexOf('\r') !== -1) f = stripStray(f, false);
    } else if (e < len) {
      f = text.slice(pos, e);
      if (lineCr === 1) {
        if (f.indexOf('\r') !== -1) f = stripStray(f, true);
      } else if (f.length > 0 && f.charCodeAt(f.length - 1) === 13) {
        f = f.slice(0, -1); // the CRLF half
      }
      pos = e + 1;
      line += 1;
      le = -1;
      lineCr = -1;
      ended = LINE_BREAK;
    } else {
      f = text.slice(pos, len);
      pos = len;
      ended = END;
      if (lineCr === 1 && f.indexOf('\r') !== -1) f = stripStray(f, false);
    }
    scanResult.value = init === '' ? f : init + f;
    scanResult.ended = ended;
    scanResult.added = f.length;
    return scanResult;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let q = text.indexOf('"', pos + 1);
    let doubled = false;
    while (q !== -1 && text.charCodeAt(q + 1) === 34) {
      doubled = true;
      q = text.indexOf('"', q + 2);
    }
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text after
      // it is read again as unquoted (unterminated_quote).
      pushErr('unterminated_quote');
      pos = open + 1;
      line = openLine;
      lineCr = -1; // the re-read starts on an earlier line than this one
      return scanUnquoted('"');
    }
    let value = text.slice(pos + 1, q);
    if (doubled) value = value.replaceAll('""', '"');
    if (value.indexOf('\r') !== -1 || value.indexOf('\n') !== -1) {
      // CRLF and a lone CR inside quotes are each one LF.
      const breaks = value.match(/\r\n?|\n/g);
      line += breaks.length;
      if (value.indexOf('\r') !== -1) value = value.replace(/\r\n?/g, '\n');
      le = -1; // the closing quote sits past the old line end
      lineCr = -1;
    }
    pos = q + 1;
    if (pos >= len) {
      scanResult.value = value;
      scanResult.ended = END;
      scanResult.added = 0;
      return scanResult;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      scanResult.value = value;
      scanResult.ended = COMMA;
      scanResult.added = 0;
      return scanResult;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      le = -1;
      lineCr = -1;
      scanResult.value = value;
      scanResult.ended = LINE_BREAK;
      scanResult.added = 0;
      return scanResult;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      le = -1;
      lineCr = -1;
      scanResult.value = value;
      scanResult.ended = LINE_BREAK;
      scanResult.added = 0;
      return scanResult;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break (quote_junk, when the field ends).
    const junk = scanUnquoted(value);
    if (junk.added > 0) pushErr('quote_junk');
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
        le = -1;
        lineCr = -1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        le = -1;
        lineCr = -1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // The record's first line, and whether it holds a quote at all: without
    // one the whole record sits on this line and splits in one call.
    const nl = text.indexOf('\n', pos);
    const lineEndIdx = nl === -1 ? len : nl;
    const firstLine = text.slice(pos, lineEndIdx);
    let fields = null;
    let quoted = false;
    if (firstLine.indexOf('"') === -1) {
      let s = firstLine;
      const r0 = s.indexOf('\r');
      if (r0 !== -1 && r0 !== s.length - 1) {
        // A stray CR inside the line: the slow path reads it.
        fields = null;
      } else {
        if (r0 !== -1) {
          if (nl !== -1) s = s.slice(0, -1); // CRLF
          else {
            s = s.slice(0, -1);
            pushErr('stray_cr'); // a lone CR at the end of the text
          }
        }
        fields = s.split(',');
        if (nl === -1) pos = len;
        else {
          pos = nl + 1;
          line += 1;
        }
        le = -1;
        lineCr = -1;
      }
    }
    if (fields === null) {
      // The slow path: the record holds a quote (or a stray CR); read it a
      // field at a time. The first line still ends at lineEndIdx. The plain
      // unquoted read is inlined here: it is the hot path of this loop.
      le = lineEndIdx;
      const fr0 = firstLine.indexOf('\r');
      lineCr = fr0 !== -1 && (fr0 !== firstLine.length - 1 || nl === -1) ? 1 : 0;
      fields = [];
      let fval;
      let fended;
      do {
        quoted = text.charCodeAt(pos) === 34;
        if (quoted) {
          const fr = readQuoted();
          fval = fr.value;
          fended = fr.ended;
        } else {
          const e = lineEnd();
          const c = text.indexOf(',', pos);
          if (c !== -1 && c < e) {
            fval = text.slice(pos, c);
            pos = c + 1;
            fended = COMMA;
            if (lineCr === 1 && fval.indexOf('\r') !== -1) fval = stripStray(fval, false);
          } else if (e < len) {
            fval = text.slice(pos, e);
            if (lineCr === 1) {
              if (fval.indexOf('\r') !== -1) fval = stripStray(fval, true);
            } else if (fval.length > 0 && fval.charCodeAt(fval.length - 1) === 13) {
              fval = fval.slice(0, -1); // the CRLF half
            }
            pos = e + 1;
            line += 1;
            le = -1;
            lineCr = -1;
            fended = LINE_BREAK;
          } else {
            fval = text.slice(pos, len);
            pos = len;
            fended = END;
            if (lineCr === 1 && fval.indexOf('\r') !== -1) fval = stripStray(fval, false);
          }
        }
        fields.push(fval);
      } while (fended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
