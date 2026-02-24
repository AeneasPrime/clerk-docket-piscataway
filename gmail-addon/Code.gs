/**
 * Send to Docket — Google Workspace Add-on for Gmail
 *
 * Opening an email with the add-on panel visible instantly shows
 * "Added to Docket". The actual send happens in the background
 * via a time-driven trigger (fires within ~1 minute).
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
 * Queues the email for background processing and returns
 * an "Added to Docket" card immediately — no GmailApp or server calls.
 */
function onGmailMessageOpen(e) {
  var messageId = e.gmail.messageId;

  // Queue for background send (UserProperties is fast — no network call)
  var props = PropertiesService.getUserProperties();
  var queue = JSON.parse(props.getProperty("DOCKET_QUEUE") || "[]");

  // Check if already queued or processed
  var dominated = false;
  for (var i = 0; i < queue.length; i++) {
    if (queue[i] === messageId) { dominated = true; break; }
  }

  if (!dominated) {
    queue.push(messageId);
    props.setProperty("DOCKET_QUEUE", JSON.stringify(queue));
    ensureProcessTrigger();
  }

  return buildAddedCard();
}

/**
 * Ensure a time-driven trigger exists to process the queue.
 * Creates one that fires after ~1 second (actual delay is up to ~1 min).
 */
function ensureProcessTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "processQueue") return;
  }
  ScriptApp.newTrigger("processQueue").timeBased().after(1000).create();
}

/**
 * Background handler: reads queued messageIds, fetches email content,
 * and sends each to the docket ingest API.
 */
function processQueue() {
  var props = PropertiesService.getUserProperties();
  var queue = JSON.parse(props.getProperty("DOCKET_QUEUE") || "[]");

  if (queue.length === 0) {
    cleanupTrigger();
    return;
  }

  var config = getConfig();
  if (!config.apiKey) {
    Logger.log("INGEST_API_KEY not set — skipping queue processing.");
    cleanupTrigger();
    return;
  }

  var remaining = [];

  for (var i = 0; i < queue.length; i++) {
    var messageId = queue[i];
    try {
      var message = GmailApp.getMessageById(messageId);
      if (!message) continue; // skip unreadable

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
      for (var j = 0; j < attachments.length; j++) {
        var att = attachments[j];
        var bytes = att.getBytes();
        if (bytes.length > MAX_ATTACHMENT_BYTES) continue;

        payload.attachments.push({
          filename: att.getName(),
          mimeType: att.getContentType(),
          data: Utilities.base64Encode(bytes)
        });
      }

      var response = UrlFetchApp.fetch(config.apiUrl, {
        method: "post",
        contentType: "application/json",
        headers: { "Authorization": "Bearer " + config.apiKey },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      var code = response.getResponseCode();
      if (code === 200 || code === 409) {
        // Success or already processed — done
        Logger.log("Docket: sent " + messageId + " (HTTP " + code + ")");
      } else {
        Logger.log("Docket: server error for " + messageId + " (HTTP " + code + ")");
        remaining.push(messageId); // retry next time
      }
    } catch (err) {
      Logger.log("Docket: error processing " + messageId + ": " + err.message);
      remaining.push(messageId); // retry next time
    }
  }

  props.setProperty("DOCKET_QUEUE", JSON.stringify(remaining));
  cleanupTrigger();
}

/**
 * Remove the processQueue time trigger so it doesn't keep firing.
 */
function cleanupTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "processQueue") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}
