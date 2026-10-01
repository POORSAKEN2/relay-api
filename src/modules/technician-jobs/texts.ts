// The texts a homeowner gets when their technician taps a button: short, signed with the
// contractor's name, and only the technician's first name.

type Who = { contractorName: string; technicianName: string }

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0]
}

export function onMyWayText(who: Who, arrival: string): string {
  return `${who.contractorName}: ${firstName(who.technicianName)} is on the way and should arrive about ${arrival}.`
}

export function runningLateText(who: Who, arrival: string): string {
  return `${who.contractorName}: ${firstName(who.technicianName)} is running late and should now arrive about ${arrival}. Sorry for the wait.`
}

export function noAccessText(who: Who, cameAt: string): string {
  return `${who.contractorName}: ${firstName(who.technicianName)} came by at ${cameAt} but couldn’t reach you. We’ll call you to set a new time.`
}
