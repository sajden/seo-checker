const protectedSurfacePattern = /design|layout|css|bild|image|navigation|navbar|formul[aä]r|cta|pris|pricing|route|redirect|positionering|kundcase|customer claim|ny sida|new page|landningssida/
const visualSurfacePattern = /design|layout|css|bild|image|navigation|navbar|formul[aä]r|spacing|mellanrum|ikon|icon|animation|visuell|visual/

export function requiresOperatorProposalText(value) {
  return protectedSurfacePattern.test(actionableText(value))
}

export function requestsVisualChangeText(value) {
  return visualSurfacePattern.test(actionableText(value))
}

function actionableText(value) {
  return String(value || '')
    .replace(
      /\butan att (?:ändra|röra)\b[^.!?\n]{0,220}/gi,
      ' '
    )
    .replace(
      /\b(?:bevara|behåll|rör inte|ändra inte|lämna)\b[^.!?\n]{0,220}(?:orörd(?:a|t)?|oförändrad(?:e|t)?|intakt(?:a)?)?[.!?]?/gi,
      ' '
    )
    .replace(
      /\b(?:utan|without)\s+(?:någon\s+|any\s+)?(?:visuell\s+|visual\s+)?(?:design|layout|css|bild|image|navigation|navbar|formul[aä]r|cta|spacing|ikon|icon|animation)?(?:s)?(?:ändring|förändring|change)s?\b/gi,
      ' '
    )
    .replace(
      /\b(?:preserve|keep|do not change|without changing)\b[^.!?\n]{0,220}/gi,
      ' '
    )
}
