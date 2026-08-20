import { describe, it, expect, vi } from 'vitest';
import { Readable, PassThrough } from 'stream';
import {
  toNodeReadable,
  assertNodeReadable,
  logBodyDiagnostics,
  UploadStreamTypeError
} from '../src/utils/StreamNormalizer';
import { classifyError } from '../src/utils/errors';

describe('Upload Tiny Stream Boundary Fix Suite', () => {

  it('TEST 1: toNodeReadable converts Buffer to a valid Node.js Readable with working .pipe()', () => {
    const buf = Buffer.from('hello world from tiny buffer test');
    const nodeStream = toNodeReadable(buf);

    expect(typeof nodeStream.pipe).toBe('function');
    expect(typeof nodeStream.on).toBe('function');
    assertNodeReadable(nodeStream, 'test-buffer.txt');

    // Read back stream data
    return new Promise<void>((resolve, reject) => {
      let data = '';
      nodeStream.on('data', chunk => { data += chunk.toString(); });
      nodeStream.on('end', () => {
        expect(data).toBe('hello world from tiny buffer test');
        resolve();
      });
      nodeStream.on('error', reject);
    });
  });

  it('TEST 2: toNodeReadable converts ArrayBuffer and Uint8Array to a valid Node.js Readable', () => {
    const uint8 = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const nodeStream = toNodeReadable(uint8.buffer);

    expect(typeof nodeStream.pipe).toBe('function');
    assertNodeReadable(nodeStream, 'arraybuffer-test');

    return new Promise<void>((resolve, reject) => {
      let data = '';
      nodeStream.on('data', chunk => { data += chunk.toString(); });
      nodeStream.on('end', () => {
        expect(data).toBe('Hello');
        resolve();
      });
      nodeStream.on('error', reject);
    });
  });

  it('TEST 3: toNodeReadable preserves existing Node.js Readable streams', () => {
    const existing = new PassThrough();
    const result = toNodeReadable(existing);

    expect(result).toBe(existing);
    expect(typeof result.pipe).toBe('function');
    assertNodeReadable(result, 'passthrough-test');
  });

  it('TEST 4: assertNodeReadable throws UploadStreamTypeError for invalid non-stream objects', () => {
    const invalidObj = { foo: 'bar', length: 100 };

    expect(() => {
      assertNodeReadable(invalidObj, 'invalid.json');
    }).toThrow(UploadStreamTypeError);
  });

  it('TEST 5: classifyError classifies "part.body.pipe is not a function" as permanent (non-retriable)', () => {
    const typeErr = new TypeError('part.body.pipe is not a function');
    const classification = classifyError(typeErr);

    expect(classification).toBe('permanent');
  });

  it('TEST 6: Multiple file types (50B, 500B, 2KB JSON, 10KB JS, 100KB binary, 1MB, Image, PDF) normalize cleanly', async () => {
    const testCases = [
      { name: 'README.md', data: Buffer.alloc(50, 'a') },
      { name: 'package.json', data: Buffer.alloc(500, '{ "name": "app" }') },
      { name: 'index.js', data: Buffer.alloc(2048, 'console.log("hi");') },
      { name: 'LICENSE', data: Buffer.alloc(10240, 'MIT License') },
      { name: 'app.pyd', data: Buffer.alloc(100 * 1024, 0x00) },
      { name: 'large.bin', data: Buffer.alloc(1024 * 1024, 0xff) },
      { name: 'photo.jpg', data: Buffer.alloc(5 * 1024, 0x89) },
      { name: 'document.pdf', data: Buffer.alloc(15 * 1024, 0x25) }
    ];

    for (const testCase of testCases) {
      const stream = toNodeReadable(testCase.data);
      expect(typeof stream.pipe).toBe('function');
      assertNodeReadable(stream, testCase.name);

      const chunk = await new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = [];
        stream.on('data', c => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
      });

      expect(chunk.length).toBe(testCase.data.length);
    }
  });

  it('TEST 7: Diagnostic logger runs safely without logging file contents or credentials', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logBodyDiagnostics(Buffer.from('secret credentials text'), 'TEST_LABEL');

    expect(consoleSpy).toHaveBeenCalled();
    const loggedText = consoleSpy.mock.calls[0][0];
    expect(loggedText).not.includes('secret credentials text');
    expect(loggedText).includes('TEST_LABEL');

    consoleSpy.mockRestore();
  });
});
