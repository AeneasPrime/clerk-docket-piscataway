/**
 * Send to Docket — Google Workspace Add-on for Gmail
 *
 * Opening an email with the add-on panel visible reads the email,
 * sends it to the docket API, and shows "Added to Docket".
 * The server quick-saves (~100ms) and defers AI classification to a cron job.
 */

var MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB per attachment

function getConfig() {
  var props = PropertiesService.getScriptProperties();
  return {
    apiUrl: props.getProperty("API_URL") || "https://clerk-docket-piscataway.onrender.com/api/ingest",
    apiKey: props.getProperty("INGEST_API_KEY") || ""
  };
}

/**
 * Contextual trigger: fires when user opens an email.
 * Sends the email to the docket and shows the result card.
 */
function onGmailMessageOpen(e) {
  var messageId = e.gmail.messageId;
  var accessToken = e.gmail.accessToken;
  var config = getConfig();

  if (!config.apiKey) {
    return buildErrorCard("INGEST_API_KEY not set. Go to Script Properties to configure it.");
  }

  GmailApp.setCurrentMessageAccessToken(accessToken);
  var message = GmailApp.getMessageById(messageId);

  if (!message) {
    return buildErrorCard("Could not read this email.");
  }

  var payload = {
    emailId: messageId,
    from: message.getFrom(),
    subject: message.getSubject(),
    date: message.getDate().toISOString(),
    bodyText: message.getPlainBody() || "",
    bodyHtml: message.getBody() || "",
    attachments: []
  };

  var attachments = message.getAttachments();
  for (var i = 0; i < attachments.length; i++) {
    var att = attachments[i];
    var bytes = att.getBytes();
    if (bytes.length > MAX_ATTACHMENT_BYTES) continue;

    payload.attachments.push({
      filename: att.getName(),
      mimeType: att.getContentType(),
      data: Utilities.base64Encode(bytes)
    });
  }

  try {
    var response = UrlFetchApp.fetch(config.apiUrl, {
      method: "post",
      contentType: "application/json",
      headers: { "Authorization": "Bearer " + config.apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var code = response.getResponseCode();
    var body = JSON.parse(response.getContentText());

    if (code === 200 && body.success) {
      return buildAddedCard();
    } else if (code === 409) {
      return buildAlreadyAddedCard();
    } else {
      return buildErrorCard(body.message || "Server error: " + code);
    }
  } catch (err) {
    return buildErrorCard("Network error: " + err.message);
  }
}
