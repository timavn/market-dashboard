// Coalesce identical instrument work across requests and bound only cache misses.
function createQuoteRequestScheduler({ concurrency = 6, maxPending = 500 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid quote concurrency');
  const pending = new Map();
  const queue = [];
  let active = 0;
  function drain() {
    while (active < concurrency && queue.length) {
      const { key, task, resolve, reject } = queue.shift();
      active += 1;
      const finish = (settle, value) => {
        active -= 1;
        pending.delete(key);
        drain();
        settle(value);
      };
      Promise.resolve().then(task).then(value => finish(resolve, value), error => finish(reject, error));
    }
  }
  return function schedule(key, task) {
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= maxPending) return Promise.reject(new Error('quote_request_capacity_exceeded'));
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    pending.set(key, promise);
    queue.push({ key, task, resolve, reject });
    drain();
    return promise;
  };
}
module.exports = { createQuoteRequestScheduler };
