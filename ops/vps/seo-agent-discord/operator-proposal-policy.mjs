const protectedSurfacePattern = /design|layout|css|bild|image|navigation|navbar|formul[aä]r|cta|pris|pricing|route|redirect|positionering|kundcase|customer claim|ny sida|new page|landningssida/

export function requiresOperatorProposalText(value) {
  const actionableText = String(value || '').replace(
    /\b(?:bevara|behåll|rör inte|ändra inte|utan att (?:ändra|röra)|preserve|keep|do not change|without changing)\b[^.!?\n]{0,220}/gi,
    ' '
  )
  return protectedSurfacePattern.test(actionableText)
}
