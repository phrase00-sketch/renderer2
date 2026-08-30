'use strict';

const assert = require('assert');
const { captureWithFallback, runLimited } = require('./adaptive-retry');

async function testConcurrencyLimit() {
  let active = 0;
  let peak = 0;
  const results = await runLimited([0, 1, 2, 3, 4], 2, async function (value) {
    active++;
    peak = Math.max(peak, active);
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
    active--;
    return value * 2;
  });
  assert.deepStrictEqual(results, [0, 2, 4, 6, 8]);
  assert.strictEqual(peak, 2);
}

async function testFourTwoOneFallback() {
  const stages = [];
  const calls = [];
  const failUntil = { 1: 1, 2: 2, 3: 3 };
  const attempts = {};

  const failed = await captureWithFallback({
    shards: [0, 1, 2, 3],
    initialConcurrency: 4,
    protocolTimeout: 180000,
    retryProtocolTimeout: 300000,
    retryEnabled: true,
    adaptive: true,
    onStage: function (stage) { stages.push(stage); },
    runShard: async function (shard, stage) {
      attempts[shard] = (attempts[shard] || 0) + 1;
      calls.push({ shard: shard, stage: stage.name, timeout: stage.timeout });
      const code = attempts[shard] <= (failUntil[shard] || 0) ? 1 : 0;
      return { shard: shard, code: code, error: null };
    },
  });

  assert.deepStrictEqual(failed, [{ shard: 3, code: 1, error: null }]);
  assert.deepStrictEqual(stages.map(function (stage) {
    return [stage.name, stage.concurrency, stage.timeout, stage.shards];
  }), [
    ['initial', 4, 180000, [0, 1, 2, 3]],
    ['adaptive', 2, 180000, [1, 2, 3]],
    ['final', 1, 300000, [2, 3]],
  ]);
  assert.deepStrictEqual(calls.filter(function (call) { return call.shard === 0; }).map(function (call) { return call.stage; }), ['initial']);
}

async function testRetryDisabled() {
  const stages = [];
  const failed = await captureWithFallback({
    shards: [0, 1, 2, 3],
    initialConcurrency: 4,
    protocolTimeout: 180000,
    retryProtocolTimeout: 300000,
    retryEnabled: false,
    adaptive: true,
    onStage: function (stage) { stages.push(stage.name); },
    runShard: async function (shard) { return { shard: shard, code: shard === 2 ? 1 : 0, error: null }; },
  });
  assert.deepStrictEqual(stages, ['initial']);
  assert.deepStrictEqual(failed.map(function (result) { return result.shard; }), [2]);
}

async function testCollapseAllStartupStalls() {
  const stages = [];
  const calls = [];
  const failed = await captureWithFallback({
    shards: [0, 1, 2, 3],
    initialConcurrency: 4,
    protocolTimeout: 180000,
    retryProtocolTimeout: 300000,
    retryEnabled: true,
    adaptive: true,
    collapseStartupStalls: true,
    onStage: function (stage) { stages.push(stage.name); },
    runShard: async function (shard, stage) {
      calls.push([shard, stage.name, !!stage.collapseAll]);
      return { shard: shard, code: stage.collapseAll ? 0 : 124, error: null };
    },
  });
  assert.deepStrictEqual(failed, []);
  assert.deepStrictEqual(stages, ['initial', 'adaptive', 'final-collapsed']);
  assert.deepStrictEqual(calls[calls.length - 1], [0, 'final-collapsed', true]);
}

(async function () {
  await testConcurrencyLimit();
  await testFourTwoOneFallback();
  await testRetryDisabled();
  await testCollapseAllStartupStalls();
  console.log('Adaptive retry tests passed.');
})().catch(function (error) {
  console.error(error && error.stack || error);
  process.exit(1);
});
