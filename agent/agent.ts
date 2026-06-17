import { defineAgent } from "eve";

import { resolvePipelineFixerModel, resolvePipelineFixerModelContextWindowTokens } from "./lib/model.ts";

const model = resolvePipelineFixerModel();
const modelContextWindowTokens = resolvePipelineFixerModelContextWindowTokens();
const compaction =
  modelContextWindowTokens === undefined
    ? { thresholdPercent: 0.75 }
    : { model, modelContextWindowTokens, thresholdPercent: 0.75 };

export default defineAgent({
  model,
  ...(modelContextWindowTokens !== undefined ? { modelContextWindowTokens } : {}),
  compaction,
});
