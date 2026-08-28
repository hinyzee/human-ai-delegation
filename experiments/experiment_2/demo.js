export const demoParticipantId = `demo_${Math.random().toString(36).slice(2)}`;

export async function initDemo() {}

export async function readDemoState(_path, fallback = null) {
  return fallback;
}

export async function writeDemoState() {
  return true;
}

export async function assignCondition(_study, _label, count) {
  return Math.floor(Math.random() * count);
}

export async function finalizeAssignment() {}

export function getDemoParams() {
  return {};
}

export function restartDemo() {
  window.location.reload();
}
