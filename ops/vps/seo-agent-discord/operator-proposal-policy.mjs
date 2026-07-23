const protectedSurfacePattern = /design|layout|css|bild|image|navigation|navbar|formul[aä]r|cta|pris|pricing|route|redirect|positionering|kundcase|customer claim|ny sida|new page|landningssida/
const visualSurfacePattern = /design|layout|css|bild|image|navigation|navbar|formul[aä]r|spacing|mellanrum|ikon|icon|animation|visuell|visual/

export function requiresOperatorProposalText(value) {
  return protectedSurfacePattern.test(actionableText(value))
}

export function requestsVisualChangeText(value) {
  return visualSurfacePattern.test(actionableText(value))
}

function actionableText(value) {
  return String(value || '').replace(
    /\b(?:bevara|behåll|rör inte|ändra inte|utan att (?:ändra|röra)|preserve|keep|do not change|without changing)\b[^.!?\n]{0,220}/gi,
    ' '
  )
}
