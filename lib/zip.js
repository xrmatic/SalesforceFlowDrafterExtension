// Minimal ZIP archive creator (no compression – "stored" method 0).
// Produces a valid PKZIP 2.0 binary that Salesforce's deployRequest accepts.
// No external dependencies required.

/**
 * Calculate CRC-32 checksum for a Uint8Array.
 * @param {Uint8Array} data
 * @returns {number} unsigned 32-bit CRC
 */
function crc32(data) {
  // Build lookup table once
  if (!crc32._table) {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      t[i] = c;
    }
    crc32._table = t;
  }
  const table = crc32._table;
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Encode a Date into MS-DOS time/date fields.
 * @param {Date} d
 * @returns {{ time: number, date: number }}
 */
function dosDateTime(d) {
  // MS-DOS time format (PKZIP spec):
  //   hours:   bits 15-11  (5 bits, 0x1F mask; spec allows 0-31 though valid range is 0-23)
  //   minutes: bits 10-5   (6 bits, 0x3F mask)
  //   seconds: bits 4-0    (5 bits, stored as seconds/2, so max stored value is 29 = 58s)
  return {
    time: ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1F),
    date: (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F),
  };
}

/** Write a little-endian 16-bit value into a DataView. */
function w16(dv, off, val) { dv.setUint16(off, val, true); }
/** Write a little-endian 32-bit value into a DataView. */
function w32(dv, off, val) { dv.setUint32(off, val, true); }

/**
 * Create a ZIP archive from an array of file descriptors.
 *
 * @param {Array<{name: string, content: string|Uint8Array}>} files
 * @returns {Uint8Array} raw ZIP bytes
 */
export function createZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const { time: modTime, date: modDate } = dosDateTime(now);

  const localParts = [];   // Uint8Array per file (header + data)
  const centralParts = []; // Uint8Array per file (central dir entry)
  const offsets = [];      // local-header byte offsets
  let pos = 0;

  for (const file of files) {
    offsets.push(pos);

    const nameBytes = enc.encode(file.name);
    const data =
      typeof file.content === 'string'
        ? enc.encode(file.content)
        : file.content;

    const checksum = crc32(data);

    // ---- Local file header (30 bytes + name) ----
    const localHeaderSize = 30 + nameBytes.length;
    const localEntry = new Uint8Array(localHeaderSize + data.length);
    const ldv = new DataView(localEntry.buffer);

    w32(ldv,  0, 0x04034B50); // signature
    w16(ldv,  4, 20);         // version needed (2.0)
    w16(ldv,  6, 0);          // general purpose bit flag
    w16(ldv,  8, 0);          // compression method: stored
    w16(ldv, 10, modTime);
    w16(ldv, 12, modDate);
    w32(ldv, 14, checksum);
    w32(ldv, 18, data.length); // compressed size (same as uncompressed)
    w32(ldv, 22, data.length); // uncompressed size
    w16(ldv, 26, nameBytes.length);
    w16(ldv, 28, 0);           // extra field length

    localEntry.set(nameBytes, 30);
    localEntry.set(data, localHeaderSize);
    localParts.push(localEntry);
    pos += localEntry.length;

    // ---- Central directory entry (46 bytes + name) ----
    const cdEntry = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cdEntry.buffer);

    w32(cdv,  0, 0x02014B50); // signature
    w16(cdv,  4, 20);         // version made by
    w16(cdv,  6, 20);         // version needed
    w16(cdv,  8, 0);          // general purpose bit flag
    w16(cdv, 10, 0);          // compression method
    w16(cdv, 12, modTime);
    w16(cdv, 14, modDate);
    w32(cdv, 16, checksum);
    w32(cdv, 20, data.length);
    w32(cdv, 24, data.length);
    w16(cdv, 28, nameBytes.length);
    w16(cdv, 30, 0);          // extra field length
    w16(cdv, 32, 0);          // file comment length
    w16(cdv, 34, 0);          // disk number start
    w16(cdv, 36, 0);          // internal file attrs
    w32(cdv, 38, 0);          // external file attrs
    w32(cdv, 42, offsets[offsets.length - 1]); // local header offset

    cdEntry.set(nameBytes, 46);
    centralParts.push(cdEntry);
  }

  const cdOffset = pos;
  const cdSize   = centralParts.reduce((s, p) => s + p.length, 0);

  // ---- End of central directory record (22 bytes) ----
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  w32(edv,  0, 0x06054B50);      // signature
  w16(edv,  4, 0);               // disk number
  w16(edv,  6, 0);               // disk with central dir start
  w16(edv,  8, files.length);    // entries on this disk
  w16(edv, 10, files.length);    // total entries
  w32(edv, 12, cdSize);          // central dir size
  w32(edv, 16, cdOffset);        // central dir offset
  w16(edv, 20, 0);               // comment length

  // ---- Combine everything ----
  const total = pos + cdSize + eocd.length;
  const zip = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, eocd]) {
    zip.set(part, cursor);
    cursor += part.length;
  }

  return zip;
}

/**
 * Convert a Uint8Array to a base64 string (works in both page and SW contexts).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toBase64(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
