// Preserve the native broker's terminal state through UI and structured consumers.
export function getAiResponseState(response) {
    if (typeof response === 'string') return 'completed'
    if (response?.status === 'cancelled') return 'cancelled'
    if (response?.status === 'failed') return 'failed'
    if (response?.status === 'partial' || ['length', 'max_tokens'].includes(response?.finishReason)) return 'partial'
    return response?.status === 'completed' || response?.finishReason ? 'completed' : 'partial'
}
