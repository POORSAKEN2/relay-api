// Gas and carbon monoxide: the one emergency the receptionist must never treat as a booking.
// Every caller turn is checked against these words before the model sees it. Speech-to-text
// writes "CO" as "co" or "c o". "Gas furnace" or "gas heater" alone is a normal call.
export const SAFETY_PHRASES = [
  'smell gas',
  'smells like gas',
  'smelling gas',
  'gas smell',
  'gas leak',
  'leaking gas',
  'rotten egg',
  'carbon monoxide',
  'co alarm',
  'co detector',
  'co monitor',
  'c o alarm',
  'c o detector',
]

export function mentionsGasOrCo(text: string): boolean {
  // Lowercase, punctuation to spaces, single spaces: "CO-alarm!" reads as "co alarm".
  const words = ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `
  return SAFETY_PHRASES.some(
    (phrase) => words.includes(` ${phrase} `) || words.includes(` ${phrase}s `),
  )
}

// Spoken word for word, never written by the model.
export const SAFETY_SCRIPT =
  'This could be dangerous. Please leave the house now, and once you are outside call your gas company or 911. Don’t use light switches or anything that could make a spark. I’m connecting you to our on-call technician now.'

// When there is nobody on call to connect them to.
export const SAFETY_SCRIPT_NO_TRANSFER =
  'This could be dangerous. Please leave the house now, and once you are outside call your gas company or 911. Don’t use light switches or anything that could make a spark. Please call 911 now.'
