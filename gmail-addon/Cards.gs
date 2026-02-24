/**
 * Card UI builders for the Send to Docket Gmail add-on.
 */

/**
 * Instant confirmation card — shown immediately when the add-on panel opens.
 */
function buildAddedCard() {
  var card = CardService.newCardBuilder();
  card.setHeader(
    CardService.newCardHeader()
      .setTitle("Added to Docket")
      .setSubtitle("Clerk Docket — Piscataway")
  );

  var section = CardService.newCardSection();
  section.addWidget(
    CardService.newDecoratedText()
      .setText("This email has been queued for the docket.")
      .setWrapText(true)
  );

  card.addSection(section);
  return card.build();
}

/**
 * Error card.
 */
function buildErrorCard(message) {
  var card = CardService.newCardBuilder();
  card.setHeader(
    CardService.newCardHeader()
      .setTitle("Error")
  );

  var section = CardService.newCardSection();
  section.addWidget(
    CardService.newDecoratedText()
      .setText(message || "An unknown error occurred.")
      .setWrapText(true)
  );

  card.addSection(section);
  return card.build();
}
