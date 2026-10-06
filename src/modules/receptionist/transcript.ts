// A call as plain text, one line per turn, kept as said:
// "AI: Thanks for calling…\nCaller: My AC stopped…". Tool calls are left out: they are in
// the logs and the audit log.
export function formatTranscript(turns: { speaker: 'caller' | 'ai'; text: string }[]): string {
  return turns.map((turn) => `${turn.speaker === 'ai' ? 'AI' : 'Caller'}: ${turn.text}`).join('\n')
}
