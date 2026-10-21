// worker.js — runs conversions of very large documents off the main thread (module worker).
import { convert } from './convert.js';

self.onmessage = (e) => {
  const { id, text, opts } = e.data;
  try {
    self.postMessage({ id, result: convert(text, opts) });
  } catch (err) {
    self.postMessage({ id, failure: String(err && err.message || err) });
  }
};
