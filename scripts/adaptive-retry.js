'use strict';

async function runLimited(items, concurrency, task) {
  const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length || 1));
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index]);
    }
  }

  const workers = [];
  for (let i = 0; i < limit; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

function failures(results) {
  return results.filter(function (result) { return result.code !== 0; });
}

async function captureWithFallback(options) {
  const shards = options.shards.slice();
  const initialConcurrency = options.initialConcurrency;
  const protocolTimeout = options.protocolTimeout;
  const retryProtocolTimeout = options.retryProtocolTimeout;
  const retryEnabled = options.retryEnabled;
  const adaptive = options.adaptive;
  const runShard = options.runShard;
  const onStage = options.onStage || function () {};

  async function runStage(name, candidates, concurrency, timeout) {
    const stage = {
      name: name,
      concurrency: Math.max(1, Math.min(concurrency, candidates.length || 1)),
      timeout: timeout,
      shards: candidates.slice(),
    };
    onStage(stage);
    return failures(await runLimited(candidates, stage.concurrency, function (shard) {
      return runShard(shard, stage);
    }));
  }

  let failed = await runStage('initial', shards, initialConcurrency, protocolTimeout);
  if (!failed.length || !retryEnabled) return failed;

  // Heavy WebGL starts fast, then reduces only the simultaneous Chromium count.
  // SHARDS stays fixed, so successful frame ranges remain reusable.
  if (adaptive && initialConcurrency > 2) {
    failed = await runStage('adaptive', failed.map(function (result) { return result.shard; }), 2, protocolTimeout);
  }

  if (failed.length) {
    failed = await runStage('final', failed.map(function (result) { return result.shard; }), 1, retryProtocolTimeout);
  }
  return failed;
}

module.exports = {
  captureWithFallback,
  runLimited,
};
