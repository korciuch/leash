// Leash: send one iMessage text to each recipient. Only runs after explicit human approval and Touch ID.
// Arg: {"recipients": ["+15551234567", "a@icloud.com"], "text": "hello"}
// Prints: {sent: n, failed: [{recipient, message}]} or {error: {app, code, message}}

function run(argv) {
  var APP = 'Messages';
  function fail(error) {
    var code = error && typeof error.errorNumber === 'number' ? error.errorNumber : null;
    var message = String((error && error.message) || error);
    if (code === null) { var m = /\((-\d+)\)/.exec(message); if (m) code = Number(m[1]); }
    return JSON.stringify({ error: { app: APP, code: code, message: message } });
  }
  function notFound(what) { var e = new Error(what); e.errorNumber = -1728; return e; }

  function iMessageService(Messages) {
    var tries = [
      function () { return Messages.services.whose({ serviceType: 'iMessage' })(); },
      function () { return Messages.accounts.whose({ serviceType: 'iMessage' })(); }
    ];
    for (var i = 0; i < tries.length; i++) {
      try { var found = tries[i](); if (found && found.length) return found[0]; } catch (e) { }
    }
    throw notFound('No iMessage account in Messages. Sign in to iMessage in Messages > Settings.');
  }

  function participantFor(Messages, service, handle) {
    var tries = [
      function () { return service.participants.byName(handle); },
      function () { return service.buddies.byName(handle); },
      function () { return Messages.participants.whose({ handle: handle })()[0]; },
      function () { return Messages.buddies.whose({ handle: handle })()[0]; }
    ];
    for (var i = 0; i < tries.length; i++) {
      try { var p = tries[i](); if (p && (typeof p.exists !== 'function' || p.exists())) return p; } catch (e) { }
    }
    return null;
  }

  try {
    var args = JSON.parse(argv[0] || '{}');
    var recipients = Array.isArray(args.recipients) ? args.recipients.map(String) : [];
    var body = String(args.text || '');
    if (!recipients.length) throw new Error('No recipients');
    if (!body) throw new Error('The text is empty');
    var Messages = Application(APP);
    var service = iMessageService(Messages);
    var sent = 0;
    var failed = [];
    for (var i = 0; i < recipients.length; i++) {
      var handle = recipients[i];
      try {
        var participant = participantFor(Messages, service, handle);
        if (!participant) throw notFound('No iMessage contact for ' + handle);
        Messages.send(body, { to: participant });
        sent++;
      } catch (e) {
        if (e && e.errorNumber === -1743) throw e;
        failed.push({ recipient: handle, message: String((e && e.message) || e) });
      }
    }
    if (!sent && failed.length) {
      var all = new Error('No text was sent: ' + failed[0].message);
      all.errorNumber = -1728;
      throw all;
    }
    return JSON.stringify({ sent: sent, failed: failed });
  } catch (error) {
    return fail(error);
  }
}
