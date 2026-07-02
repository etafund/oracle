import assert from "node:assert/strict";

function makePayload(sizeBytes) {
  return "x".repeat(sizeBytes);
}

function measure(sizeBytes) {
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  const event = {
    type: "claude_code_visible_stream",
    stream: "stdout",
    byteOffset: 0,
    byteLength: sizeBytes,
    text: makePayload(sizeBytes),
  };
  const envelope = {
    status: "completed",
    eventsComplete: true,
    streamsComplete: true,
    visibleEvents: [event],
    rawResources: [],
  };
  const json = JSON.stringify(envelope);
  const after = process.memoryUsage().heapUsed;
  assert.equal(JSON.parse(json).visibleEvents[0].byteLength, sizeBytes);
  return {
    visibleBytes: sizeBytes,
    jsonBytes: Buffer.byteLength(json),
    heapDeltaBytes: Math.max(0, after - before),
  };
}

const sizes = [10 * 1024, 100 * 1024, 1024 * 1024, 10 * 1024 * 1024];
console.log(JSON.stringify(sizes.map(measure), null, 2));
