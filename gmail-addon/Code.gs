/**
 * Send to Docket — Google Workspace Add-on for Gmail
 *
 * Click the add-on icon on any email to see the "Add to Docket" button.
 * Click the button to send the email to the docket for classification.
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
 * Shows a lightweight card instantly — no server call.
 */
function onGmailMessageOpen(e) {
  var messageId = e.gmail.messageId;
  var accessToken = e.gmail.accessToken;

  GmailApp.setCurrentMessageAccessToken(accessToken);
  var message = GmailApp.getMessageById(messageId);

  if (!message) {
    return buildErrorCard("Could not read this email.");
  }

  // Check if already sent (local cache to avoid redundant sends)
  var cache = CacheService.getUserCache();
  var cached = cache.get("docket_" + messageId);
  if (cached) {
    var data = JSON.parse(cached);
    return buildAlreadyProcessedCard(data);
  }

  return buildMainCard(messageId, message.getSubject(), message.getFrom());
}

/**
 * Action handler: user clicked "Add to Docket" button.
 * Sends the email to the server.
 */
function onSendToDocket(e) {
  var messageId = e.parameters.messageId;
  var config = getConfig();

  if (!config.apiKey) {
    return buildErrorCard("INGEST_API_KEY not set. Go to Script Properties to configure it.");
  }

  var accessToken = e.gmail.accessToken;
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
      headers: {
        "Authorization": "Bearer " + config.apiKey
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var code = response.getResponseCode();
    var body = JSON.parse(response.getContentText());

    if (code === 200 && body.success) {
      // Cache the result so re-opening this email shows "already processed"
      var cache = CacheService.getUserCache();
      cache.put("docket_" + messageId, JSON.stringify({ docketId: body.docketId }), 86400);
      return buildSuccessCard(body);
    } else if (code === 409) {
      var cache = CacheService.getUserCache();
      cache.put("docket_" + messageId, JSON.stringify({ docketId: body.docketId }), 86400);
      return buildAlreadyProcessedCard(body);
    } else {
      return buildErrorCard(body.message || "Server error: " + code);
    }
  } catch (err) {
    return buildErrorCard("Network error: " + err.message);
  }
}
