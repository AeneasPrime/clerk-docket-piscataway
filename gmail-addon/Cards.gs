/**
 * Card UI builders for the Send to Docket Gmail add-on.
 */

/**
 * Confirmation card — email was added to the docket.
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
      .setText("This email has been added to the docket.")
      .setWrapText(true)
  );

  card.addSection(section);
  return card.build();
}

/**
 * Card shown when the email was already in the docket.
 */
function buildAlreadyAddedCard() {
  var card = CardService.newCardBuilder();
  card.setHeader(
    CardService.newCardHeader()
      .setTitle("Already in Docket")
      .setSubtitle("Clerk Docket — Piscataway")
  );

  var section = CardService.newCardSection();
  section.addWidget(
    CardService.newDecoratedText()
      .setText("This email has already been sent to the docket.")
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
