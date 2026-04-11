// Classifier Evaluation Runner — tests Haiku intent classifier against 120+ cases
// Run: deno run --allow-net --allow-env --allow-read --allow-write tests/classifier-eval.ts
// Requires: ANTHROPIC_API_KEY environment variable

import { ALL_CASES, MOCK_CONTEXT, CASE_COUNTS } from "./classifier-test-cases.ts";
import { classifyIntent, type ClassifierContext } from "../supabase/functions/_shared/haiku-classifier.ts";

// ─── Configuration ───

const CONCURRENCY = 10;
const RESULTS_FILE = "./tests/classifier-results.json";

// ─── Build context from mock data ───

function buildTestContext(): ClassifierContext {
  const today = new Date();
  const hebrewDays = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const pad = (n: number) => String(n).padStart(2, "0");

  return {
    members: MOCK_CONTEXT.members,
    openTasks: MOCK_CONTEXT.openTasks,
    openShopping: MOCK_CONTEXT.openShopping,
    today: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
    dayOfWeek: hebrewDays[today.getDay()],
  };
}

// ─── Concurrent execution with semaphore ───

async function runWithConcurrency<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── Types ───

interface TestResult {
  input: string;
  sender: string;
  expected: string;
  actual: string;
  confidence: number;
  correct: boolean;
  latencyMs: number;
  entities: Record<string, unknown>;
  notes?: string;
}

interface EvalSummary {
  timestamp: string;
  totalCases: number;
  correct: number;
  accuracy: number;
  perIntent: Record<string, { total: number; correct: number; accuracy: number }>;
  confusionMatrix: Record<string, Record<string, number>>;
  avgLatencyMs: number;
  avgConfidence: number;
  misclassifications: Array<{
    input: string;
    sender: string;
    expected: string;
    actual: string;
    confidence: number;
    notes?: string;
  }>;
}

// ─── Main evaluation ───

async function runEval(): Promise<EvalSummary> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.error("ERROR: ANTHROPIC_API_KEY environment variable is required");
    Deno.exit(1);
  }

  const ctx = buildTestContext();
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  Haiku Intent Classifier Evaluation          ║`);
  console.log(`╠══════════════════════════════════════════════╣`);
  console.log(`║  Cases: ${ALL_CASES.length.toString().padEnd(5)} | Concurrency: ${CONCURRENCY.toString().padEnd(5)}       ║`);
  console.log(`║  Date:  ${ctx.today}                        ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);

  console.log("Distribution:", CASE_COUNTS);
  console.log("\nRunning...\n");

  const startTime = Date.now();
  let completed = 0;

  const results = await runWithConcurrency(
    ALL_CASES,
    async (tc, _idx) => {
      const t0 = Date.now();
      const result = await classifyIntent(tc.input, tc.sender, ctx, apiKey);
      const latencyMs = Date.now() - t0;

      completed++;
      if (completed % 10 === 0 || completed === ALL_CASES.length) {
        const pct = Math.round((completed / ALL_CASES.length) * 100);
        console.log(`  Progress: ${completed}/${ALL_CASES.length} (${pct}%)`);
      }

      return {
        input: tc.input,
        sender: tc.sender,
        expected: tc.expectedIntent,
        actual: result.intent,
        confidence: result.confidence,
        correct: result.intent === tc.expectedIntent,
        latencyMs,
        entities: result.entities,
        notes: tc.notes,
      } as TestResult;
    },
    CONCURRENCY
  );

  const totalTime = Date.now() - startTime;

  // ─── Compute metrics ───

  const correct = results.filter((r) => r.correct).length;
  const accuracy = correct / results.length;

  // Per-intent accuracy
  const intents = [...new Set(ALL_CASES.map((c) => c.expectedIntent))];
  const perIntent: Record<string, { total: number; correct: number; accuracy: number }> = {};
  for (const intent of intents) {
    const intentResults = results.filter((r) => r.expected === intent);
    const intentCorrect = intentResults.filter((r) => r.correct).length;
    perIntent[intent] = {
      total: intentResults.length,
      correct: intentCorrect,
      accuracy: intentResults.length > 0 ? intentCorrect / intentResults.length : 0,
    };
  }

  // Confusion matrix
  const allIntents = [...new Set([...intents, ...results.map((r) => r.actual)])].sort();
  const confusionMatrix: Record<string, Record<string, number>> = {};
  for (const expected of allIntents) {
    confusionMatrix[expected] = {};
    for (const actual of allIntents) {
      confusionMatrix[expected][actual] = 0;
    }
  }
  for (const r of results) {
    if (!confusionMatrix[r.expected]) confusionMatrix[r.expected] = {};
    confusionMatrix[r.expected][r.actual] = (confusionMatrix[r.expected][r.actual] || 0) + 1;
  }

  // Misclassifications
  const misclassifications = results
    .filter((r) => !r.correct)
    .map((r) => ({
      input: r.input,
      sender: r.sender,
      expected: r.expected,
      actual: r.actual,
      confidence: r.confidence,
      notes: r.notes,
    }));

  const avgLatencyMs = results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length;
  const avgConfidence = results.reduce((sum, r) => sum + r.confidence, 0) / results.length;

  const summary: EvalSummary = {
    timestamp: new Date().toISOString(),
    totalCases: results.length,
    correct,
    accuracy,
    perIntent,
    confusionMatrix,
    avgLatencyMs,
    avgConfidence,
    misclassifications,
  };

  // ─── Print results ───

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Overall Accuracy: ${(accuracy * 100).toFixed(1)}% (${correct}/${results.length})`);
  console.log(`  Avg Latency:      ${avgLatencyMs.toFixed(0)}ms`);
  console.log(`  Avg Confidence:   ${(avgConfidence * 100).toFixed(1)}%`);
  console.log(`  Total Time:       ${(totalTime / 1000).toFixed(1)}s`);
  console.log();

  // Per-intent table
  console.log(`  ${"Intent".padEnd(20)} ${"Total".padEnd(7)} ${"Correct".padEnd(9)} Accuracy`);
  console.log(`  ${"─".repeat(50)}`);
  for (const intent of intents.sort()) {
    const pi = perIntent[intent];
    const acc = (pi.accuracy * 100).toFixed(1);
    const pass = pi.accuracy >= 0.8 ? "✓" : pi.accuracy >= 0.7 ? "~" : "✗";
    console.log(
      `  ${pass} ${intent.padEnd(18)} ${String(pi.total).padEnd(7)} ${String(pi.correct).padEnd(9)} ${acc}%`
    );
  }

  // Confusion matrix (compact)
  if (misclassifications.length > 0) {
    console.log(`\n  CONFUSION MATRIX (rows=expected, cols=actual)`);
    const labels = allIntents.map((i) => i.slice(0, 8).padEnd(8));
    console.log(`  ${"".padEnd(18)} ${labels.join(" ")}`);
    for (const expected of allIntents) {
      const row = allIntents.map((actual) =>
        String(confusionMatrix[expected]?.[actual] || 0).padEnd(8)
      );
      console.log(`  ${expected.padEnd(18)} ${row.join(" ")}`);
    }
  }

  // Misclassifications detail
  if (misclassifications.length > 0) {
    console.log(`\n  MISCLASSIFICATIONS (${misclassifications.length}):`);
    console.log(`  ${"─".repeat(50)}`);
    for (const m of misclassifications) {
      console.log(`  [${m.sender}]: "${m.input}"`);
      console.log(`    Expected: ${m.expected} → Got: ${m.actual} (conf: ${(m.confidence * 100).toFixed(0)}%)`);
      if (m.notes) console.log(`    Note: ${m.notes}`);
      console.log();
    }
  }

  // Pass/fail
  console.log(`${"═".repeat(60)}`);
  const passed = accuracy >= 0.85;
  const ignorePass = (perIntent["ignore"]?.accuracy || 0) >= 0.9;
  console.log(`  Overall ≥85%:  ${passed ? "PASS ✓" : "FAIL ✗"} (${(accuracy * 100).toFixed(1)}%)`);
  console.log(`  Ignore ≥90%:   ${ignorePass ? "PASS ✓" : "FAIL ✗"} (${((perIntent["ignore"]?.accuracy || 0) * 100).toFixed(1)}%)`);
  console.log(`${"═".repeat(60)}\n`);

  return summary;
}

// ─── Run and save ───

const summary = await runEval();

// Save results to JSON
try {
  await Deno.writeTextFile(RESULTS_FILE, JSON.stringify(summary, null, 2));
  console.log(`Results saved to ${RESULTS_FILE}`);
} catch (err) {
  console.error("Could not save results file:", err);
}

// Exit with error code if below threshold
if (summary.accuracy < 0.85) {
  console.error(`\nFAILED: Accuracy ${(summary.accuracy * 100).toFixed(1)}% is below 85% threshold`);
  Deno.exit(1);
}
