/**
 * Slice 6 Task 3 — legacy wrapper; **not mounted** by `App.tsx`.
 *
 * The live route **`/adviser/ai-planning`** uses **`ai-planning-v2.tsx`**
 * (`AdviserAiPlanningV2`). Older paths (`/adviser/workflow`, `/adviser/instructions`,
 * etc.) **`Redirect`** to `/adviser/ai-planning` in `App.tsx` — they never render this file.
 *
 * This module re-exported `workflow.tsx` while the redesigned surface shipped; keep it
 * only so the obsolete entry stays visible during cleanup. Do not extend; remove once
 * `workflow.tsx` consolidation is deliberate.
 *
 * @deprecated Import from `./ai-planning-v2` or navigate to `/adviser/ai-planning`.
 */
import AdviserWorkflow from "@/pages/adviser/workflow";

/** @deprecated Unreachable at runtime with current routing; see module comment above. */
export default function AdviserAiPlanningPage() {
  return <AdviserWorkflow />;
}
