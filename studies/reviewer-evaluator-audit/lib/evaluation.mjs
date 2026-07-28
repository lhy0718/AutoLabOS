import {
  normalizeComparableText,
  splitSentences,
} from "./corpus.mjs";

export function tokenizeWords(text) {
  const normalized = String(text).toLowerCase().trim();
  return normalized ? normalized.split(/\s+/u) : [];
}

export function tokenLevenshteinDistance(left, right) {
  const leftTokens = Array.isArray(left) ? left : tokenizeWords(left);
  const rightTokens = Array.isArray(right) ? right : tokenizeWords(right);
  if (leftTokens.length === 0) return rightTokens.length;
  if (rightTokens.length === 0) return leftTokens.length;
  let previous = Array.from({ length: rightTokens.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= leftTokens.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= rightTokens.length; rightIndex += 1) {
      const cost = leftTokens[leftIndex - 1] === rightTokens[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + cost,
      );
    }
    previous = current;
  }
  return previous[rightTokens.length];
}

export function normalizedTokenSimilarity(left, right) {
  const leftTokens = tokenizeWords(left);
  const rightTokens = tokenizeWords(right);
  const denominator = Math.max(leftTokens.length, rightTokens.length);
  if (denominator === 0) return 1;
  return 1 - tokenLevenshteinDistance(leftTokens, rightTokens) / denominator;
}

export function tokenSimilarityExceeds(left, right, threshold) {
  const leftTokens = tokenizeWords(left);
  const rightTokens = tokenizeWords(right);
  const maximumLength = Math.max(leftTokens.length, rightTokens.length);
  if (maximumLength === 0) return 1 > threshold;
  const maximumDistance = Math.ceil((1 - threshold) * maximumLength) - 1;
  if (maximumDistance < 0) return false;
  if (Math.abs(leftTokens.length - rightTokens.length) > maximumDistance) {
    return false;
  }
  let previous = Array.from(
    { length: rightTokens.length + 1 },
    (_, index) => Math.min(index, maximumDistance + 1),
  );
  for (let leftIndex = 1; leftIndex <= leftTokens.length; leftIndex += 1) {
    const current = [Math.min(leftIndex, maximumDistance + 1)];
    let rowMinimum = current[0];
    for (let rightIndex = 1; rightIndex <= rightTokens.length; rightIndex += 1) {
      const cost = leftTokens[leftIndex - 1] === rightTokens[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        maximumDistance + 1,
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + cost,
      );
      rowMinimum = Math.min(rowMinimum, current[rightIndex]);
    }
    if (rowMinimum > maximumDistance) return false;
    previous = current;
  }
  return previous[rightTokens.length] <= maximumDistance;
}

export function publishedCodeTokenSimilarity(left, right) {
  const leftTokens = tokenizeWords(left);
  const rightTokens = tokenizeWords(right);
  const m = leftTokens.length;
  const n = rightTokens.length;
  if (m === 0 && n === 0) return 1;
  if (m === 0 || n === 0) return 0;
  let previous = Array.from({ length: n + 1 }, (_, index) => index);
  let finalSimilarities = Array(n + 1).fill(0);
  for (let leftIndex = 1; leftIndex <= m; leftIndex += 1) {
    const current = [leftIndex];
    const similarities = Array(n + 1).fill(0);
    for (let rightIndex = 1; rightIndex <= n; rightIndex += 1) {
      const cost = leftTokens[leftIndex - 1] === rightTokens[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + cost,
      );
      similarities[rightIndex] =
        1 - current[rightIndex] / Math.max(leftIndex, rightIndex);
    }
    previous = current;
    if (leftIndex === m) finalSimilarities = similarities;
  }
  return Math.max(...finalSimilarities);
}

export function publishedCodeBestSubspanSimilarity(
  prediction,
  truthSpans,
  threshold = 0.5,
) {
  const normalizedPrediction = String(prediction).trim().toLowerCase();
  if (!normalizedPrediction) return 0;
  let best = 0;
  for (const truth of truthSpans) {
    const sentences = String(truth).split(/(?<=[.!?])\s+/u);
    for (let start = 0; start < sentences.length; start += 1) {
      const suffix = sentences.slice(start).join(" ");
      const similarity = publishedCodeTokenSimilarity(normalizedPrediction, suffix);
      best = Math.max(best, similarity);
      if (best >= threshold) return best;
    }
  }
  return best;
}

export function publishedCodeDetection({
  truthSpans,
  predictions,
  topK = 10,
  threshold = 0.5,
}) {
  const retainedPredictions = predictions.slice(0, topK);
  const forward = retainedPredictions.map((prediction) =>
    publishedCodeBestSubspanSimilarity(prediction, truthSpans, threshold));
  if (forward.length === 0) {
    return {
      identified: true,
      maximum: 1,
      forward,
      reverse: [],
      empty_prediction_fail_open: true,
    };
  }
  const forwardMaximum = Math.max(...forward);
  if (forwardMaximum >= threshold) {
    return {
      identified: true,
      maximum: forwardMaximum,
      forward,
      reverse: [],
      empty_prediction_fail_open: false,
    };
  }
  const reverse = truthSpans.map((truth) =>
    publishedCodeBestSubspanSimilarity(truth, retainedPredictions, threshold));
  const maximum = Math.max(forwardMaximum, 0, ...reverse);
  return {
    identified: maximum >= threshold,
    maximum,
    forward,
    reverse,
    empty_prediction_fail_open: false,
  };
}

export function contiguousSentenceSpans(text) {
  const sentences = splitSentences(text);
  const spans = [];
  for (let start = 0; start < sentences.length; start += 1) {
    for (let end = start + 1; end <= sentences.length; end += 1) {
      spans.push(sentences.slice(start, end).join(" "));
    }
  }
  return spans;
}

export function paperSpecifiedPairSimilarity(truth, prediction, stopAbove) {
  let best = 0;
  for (const span of contiguousSentenceSpans(truth)) {
    best = Math.max(best, normalizedTokenSimilarity(span, prediction));
    if (stopAbove !== undefined && best > stopAbove) return best;
  }
  for (const span of contiguousSentenceSpans(prediction)) {
    best = Math.max(best, normalizedTokenSimilarity(truth, span));
    if (stopAbove !== undefined && best > stopAbove) return best;
  }
  return best;
}

export function paperSpecifiedDetection({
  truthSpans,
  predictions,
  topK = 10,
  threshold = 0.5,
}) {
  const retainedPredictions = predictions.slice(0, topK);
  for (const prediction of retainedPredictions) {
    for (const truth of truthSpans) {
      for (const span of contiguousSentenceSpans(truth)) {
        if (tokenSimilarityExceeds(span, prediction, threshold)) {
          return { identified: true };
        }
      }
      for (const span of contiguousSentenceSpans(prediction)) {
        if (tokenSimilarityExceeds(truth, span, threshold)) {
          return { identified: true };
        }
      }
    }
  }
  return { identified: false };
}

export function changedModifiedSentences(originalTexts, modifiedTexts) {
  const changed = [];
  const pairCount = Math.min(originalTexts.length, modifiedTexts.length);
  for (let index = 0; index < pairCount; index += 1) {
    const originals = new Set(
      splitSentences(originalTexts[index]).map(normalizeComparableText),
    );
    for (const sentence of splitSentences(modifiedTexts[index])) {
      if (!originals.has(normalizeComparableText(sentence))) changed.push(sentence);
    }
  }
  return [...new Map(
    changed.map((sentence) => [normalizeComparableText(sentence), sentence]),
  ).values()];
}
