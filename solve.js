// Fast drop-in for csv-reader 1.0.0: readCsv semantics, reimplemented from
// scratch as a single-pass scanner. No dependencies, no regex, no network.
// Strategy: fields are extracted with slice() once their end is found with
// native indexOf() scans; per-character work happens only on the rare paths
// (lone CRs, line breaks inside quoted fields, doubled quotes).

const COMMA = 0;
const BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // Error for the record currently being read.
  let recordLine = 1;
  let recordRow = null;
  function err(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Parse an unquoted field starting at pos, with `prefix` already kept
  // ('' normally, '"' after an unterminated quote, or the quoted value for
  // quote junk). Returns [value, ended, added].
  function unquoted(prefix) {
    let value = prefix;
    let added = 0;
    let iC = text.indexOf(',', pos);
    let iL = text.indexOf('\n', pos);
    let end = n;
    let kind = END;
    if (iC !== -1 && iC < end) { end = iC; kind = COMMA; }
    if (iL !== -1 && iL < end) { end = iL; kind = BREAK; }
    let seg = text.slice(pos, end);
    // A CR immediately before the LF that ends the field is the CRLF line
    // break, not a stray CR.
    if (kind === BREAK && seg.charCodeAt(seg.length - 1) === 13) {
      seg = seg.slice(0, -1);
    }
    const cr = seg.indexOf('\r');
    if (cr === -1) {
      value += seg;
      added += seg.length;
    } else {
      // Every remaining CR is lone: dropped, one stray_cr each.
      let out = value + seg.slice(0, cr);
      added += cr;
      err('stray_cr');
      for (let k = cr + 1; k < seg.length; k++) {
        if (seg.charCodeAt(k) === 13) { err('stray_cr'); continue; }
        out += seg[k];
        added += 1;
      }
      value = out;
    }
    if (kind === COMMA) { pos = end + 1; }
    else if (kind === BREAK) { pos = end + 1; line += 1; }
    else { pos = end; }
    return [value, kind, added];
  }

  // Parse a quoted field whose opening quote is at pos.
  // Returns [value, ended] or null when the quote never closes (caller then
  // re-reads from after the opening quote as unquoted, with '"' kept).
  function quoted(open) {
    const openLine = line;
    let value = '';
    pos = open + 1;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        pos = open + 1;
        line = openLine;
        err('unterminated_quote');
        return null;
      }
      const seg = text.slice(pos, q);
      if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) {
        value += seg;
      } else {
        // Line breaks inside quotes each become one LF in the value and
        // each count once for the line number (CRLF counts once).
        let out = value;
        let s = 0;
        for (let k = 0; k < seg.length; k++) {
          const ch = seg.charCodeAt(k);
          if (ch === 13) {
            out += seg.slice(s, k) + '\n';
            line += 1;
            if (seg.charCodeAt(k + 1) === 10) k += 1;
            s = k + 1;
          } else if (ch === 10) {
            out += seg.slice(s, k) + '\n';
            line += 1;
            s = k + 1;
          }
        }
        value = out + seg.slice(s);
      }
      if (text.charCodeAt(q + 1) === 34) {
        value += '"';
        pos = q + 2;
        continue;
      }
      // Closing quote found.
      pos = q + 1;
      if (pos >= n) return [value, END];
      const c = text.charCodeAt(pos);
      if (c === 44) { pos += 1; return [value, COMMA]; }
      if (c === 10) { pos += 1; line += 1; return [value, BREAK]; }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        return [value, BREAK];
      }
      // Junk follows the closing quote: appended as it stands.
      const junk = unquoted(value);
      if (junk[2] > 0) err('quote_junk');
      return [junk[0], junk[1]];
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    let ended;
    do {
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        const q = quoted(pos);
        if (q === null) {
          // Unterminated quote: literal '"' then re-read as unquoted.
          const u = unquoted('"');
          fields.push(u[0]);
          ended = u[1];
        } else {
          fields.push(q[0]);
          ended = q[1];
        }
      } else {
        lastQuoted = false;
        const u = unquoted('');
        fields.push(u[0]);
        ended = u[1];
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

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
