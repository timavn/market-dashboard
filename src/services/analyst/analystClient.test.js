import { ANALYST_PDF_MAX_BYTES, validateAnalystPdf } from './analystClient';

const fileLike = ({ name = 'deck.pdf', type = 'application/pdf', bytes = '%PDF-', size } = {}) => {
  const encoded = Uint8Array.from([...bytes].map((character) => character.charCodeAt(0)));
  return {
    name,
    type,
    size: size ?? encoded.byteLength,
    slice: () => ({ arrayBuffer: async () => encoded.buffer }),
  };
};

describe('Analyst PDF client validation', () => {
  test('accepts a bounded PDF with the correct MIME and signature', async () => {
    await expect(validateAnalystPdf(fileLike())).resolves.toBe(true);
  });

  test.each([
    [fileLike({ name: 'deck.txt' }), /Only PDF/],
    [fileLike({ type: 'text/plain' }), /application\/pdf/],
    [fileLike({ size: 0 }), /empty/],
    [fileLike({ size: ANALYST_PDF_MAX_BYTES + 1 }), /50 MB/],
    [fileLike({ bytes: 'NOPE!' }), /signature/],
  ])('rejects an invalid file', async (file, expected) => {
    await expect(validateAnalystPdf(file)).rejects.toThrow(expected);
  });
});
