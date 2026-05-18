export function normalizeSpeakerLabels(input) {
  const entries = [];
  if (Array.isArray(input)) {
    for (const item of input) {
      entries.push([item?.label ?? item?.key ?? item?.speaker, item?.name ?? item?.value ?? item?.displayName]);
    }
  } else if (input && typeof input === "object") {
    entries.push(...Object.entries(input));
  }

  return Object.fromEntries(
    entries
      .map(([label, name]) => [normalizeSpeakerLabel(label), String(name || "").trim().slice(0, 80)])
      .filter(([label, name]) => label && name)
  );
}

export function detectSpeakerLabels(sourceFile = {}, ...texts) {
  const labels = new Set(Object.keys(normalizeSpeakerLabels(sourceFile.speakerLabels || {})));
  const speakerCount = Number(sourceFile.speakerCount || sourceFile.asrOptions?.speakerCount || 0);
  if (Number.isFinite(speakerCount) && speakerCount > 1) {
    for (let index = 1; index <= Math.min(speakerCount, 20); index += 1) labels.add(`说话人${index}`);
  }

  for (const text of texts) {
    for (const match of String(text || "").matchAll(/(?:Speaker|说话人)\s*[_-]?\s*([A-Za-z0-9一二三四五六七八九十]+)/g)) {
      const prefix = /^speaker/i.test(match[0]) ? "Speaker" : "说话人";
      const label = normalizeSpeakerLabel(`${prefix} ${match[1]}`);
      if (label) labels.add(label);
      if (labels.size >= 20) break;
    }
  }

  return [...labels].slice(0, 20);
}

export function applySpeakerLabelsToText(text, speakerLabels = {}) {
  const normalized = normalizeSpeakerLabels(speakerLabels);
  let output = String(text || "");
  const labels = Object.keys(normalized).sort((a, b) => b.length - a.length);
  for (const label of labels) {
    const name = normalized[label];
    if (!name) continue;
    const pattern = speakerLabelPattern(label);
    output = output.replace(pattern, `${name}（${label}）`);
  }
  return output;
}

export function normalizeSpeakerLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const speakerMatch = raw.match(/^speaker\s*[_-]?\s*([A-Za-z0-9一二三四五六七八九十]+)$/i);
  if (speakerMatch) return `Speaker ${speakerMatch[1]}`;
  const cnMatch = raw.match(/^说话人\s*[_-]?\s*([A-Za-z0-9一二三四五六七八九十]+)$/i);
  if (cnMatch) return `说话人${cnMatch[1]}`;
  return raw.replace(/\s+/g, " ").slice(0, 80);
}

function speakerLabelPattern(label) {
  const normalized = normalizeSpeakerLabel(label);
  if (/^Speaker\s+/i.test(normalized)) {
    const suffix = normalized.replace(/^Speaker\s+/i, "");
    return new RegExp(`Speaker\\s*[_-]?\\s*${escapeRegExp(suffix)}(?![A-Za-z0-9])`, "g");
  }
  if (/^说话人/.test(normalized)) {
    const suffix = normalized.replace(/^说话人/, "");
    return new RegExp(`说话人\\s*[_-]?\\s*${escapeRegExp(suffix)}(?![A-Za-z0-9一二三四五六七八九十])`, "g");
  }
  return new RegExp(escapeRegExp(normalized), "g");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
