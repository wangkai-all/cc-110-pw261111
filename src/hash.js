// 固定标识规范的一部分：MurmurHash3 x86_32，种子在 HLL SPEC 中固定。
// 输入为标识符的 UTF-8 字节，输出无符号 32 位整数。
// 参考: Appleby MurmurHash3 参考实现 (public domain)。

const encoder = new TextEncoder();

export function murmurHash3_32(bytes, seed = 0) {
  let h = seed >>> 0;
  const len = bytes.length;
  const nblocks = len >> 2;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;

  for (let i = 0; i < nblocks; i++) {
    const off = i * 4;
    let k =
      (bytes[off] & 0xff) |
      ((bytes[off + 1] & 0xff) << 8) |
      ((bytes[off + 2] & 0xff) << 16) |
      ((bytes[off + 3] & 0xff) << 24);

    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);

    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  }

  let k = 0;
  const tail = nblocks * 4;
  switch (len & 3) {
    case 3:
      k ^= bytes[tail + 2] << 16;
    // falls through
    case 2:
      k ^= bytes[tail + 1] << 8;
    // falls through
    case 1:
      k ^= bytes[tail];
      k = Math.imul(k, c1);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, c2);
      h ^= k;
  }

  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;

  return h >>> 0;
}

export function hashIdentifier(id, seed) {
  const bytes = encoder.encode(id);
  return murmurHash3_32(bytes, seed);
}
