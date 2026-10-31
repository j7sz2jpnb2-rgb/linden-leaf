// Queue local admission waits. Never retry a request that may have reached the provider.
function aborted(signal) {
  if (signal?.aborted) throw new DOMException('AI request cancelled while waiting', 'AbortError');
}

function admissionCode(error) {
  const message = typeof error === 'string' ? error : error?.message || '';
  return message.match(/^(COOLDOWN_ACTIVE|CONCURRENCY_BLOCKED):/)?.[1] || null;
}

function delay(ms, signal) {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', stop);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); cleanup(); reject(new DOMException('AI request cancelled while waiting', 'AbortError')); };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  });
}

export async function runWithAiAdmission({ invoke, getStatus, signal, beforeDispatch, onWait }) {
  for (;;) {
    aborted(signal);
    await beforeDispatch?.();
    aborted(signal);
    const status = await getStatus();
    aborted(signal);
    const remainingMs = Math.max(0, Number(status.remainingCooldownMs ?? ((status.remainingCooldownSeconds ?? 0) * 1000)) || 0);
    const quota = Number(status.dailyLimit) || 0;
    if (quota > 0 && Number(status.todayCount) >= quota) {
      throw new Error(`DAILY_LIMIT_EXCEEDED: 已达到今日请求上限 (${quota} 次)`);
    }
    if (status.isBusy || remainingMs > 0) {
      const reason = status.isBusy ? 'busy' : 'cooldown';
      onWait?.({ reason, remainingMs });
      await delay(status.isBusy ? 350 : Math.min(remainingMs + 25, 1000), signal);
      continue; // Recheck the authoritative backend clock after waiting.
    }
    await beforeDispatch?.();
    aborted(signal);
    try {
      return await invoke();
    } catch (error) {
      const code = admissionCode(error);
      if (!code) throw error;
      // These native errors precede dispatch, quota accounting and request-ID registration.
      // A competing chat request can take the slot after our status query.
      onWait?.({ reason: code === 'COOLDOWN_ACTIVE' ? 'cooldown' : 'busy', remainingMs: 0 });
      await delay(50, signal);
    }
  }
}
