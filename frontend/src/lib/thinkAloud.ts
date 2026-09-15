/**
 * How the training phase is split into blocks: each number is a run of cases
 * that is worked through before that many think-aloud screens play. Only the
 * training phase batches, so this describes that phase alone.
 *
 * The last block is short whenever the batch size does not divide the phase
 * evenly — seven cases in threes is 3, 3, 1 — which is worth showing the
 * researcher before they commit to a number.
 */
export function thinkAloudBlocks(trainingCases: number, batchSize: number): number[] {
  const size = Math.max(1, Math.floor(batchSize) || 1)
  const blocks: number[] = []
  for (let left = Math.max(0, Math.floor(trainingCases)); left > 0; left -= size) {
    blocks.push(Math.min(size, left))
  }
  return blocks
}
