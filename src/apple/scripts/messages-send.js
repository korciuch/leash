// Leash: send one iMessage text to each recipient. Only runs after explicit human approval and Touch ID.
// Arg: {"recipients": ["+15551234567", "a@icloud.com"], "text": "hello"}
// Prints: {sent: n, failed: [{recipient, message}]} or {error: {app, code, message}}
// Written for the JXA dictionaries of macOS 14 through 27: accounts() or services(), participants or buddies.

function run(argv) {
  var APP = 'Messages';
  var NO_IMESSAGE = 'Messages is not signed in to iMessage. Open Messages > Settings > iMessage and sign in.';
  function fail(error) {
    if (error && error.leashCode) return JSON.stringify({ error: { app: APP, code: error.leashCode, message: String(error.message) } });
    var code = error && typeof error.errorNumber === 'number' ? error.errorNumber : null;
    var message = String((error && error.message) || error);
    if (code === null) { var m = /\((-\d+)\)/.exec(message); if (m) code = Number(m[1]); }
    return JSON.stringify({ error: { app: APP, code: code, message: message } });
  }
  function attempt(fn) { try { return fn(); } catch (e) { if (e && e.errorNumber === -1743) throw e; return undefined; } }
  function call(obj, name) { return attempt(function () { return typeof obj[name] === 'function' ? obj[name]() : obj[name]; }); }

  // Every iMessage account or service, enabled ones first. Messages.accounts() on newer macOS, services() on older.
  function iMessageAccounts(Messages) {
    var all = [];
    var lists = [
      attempt(function () { return Messages.accounts(); }),
      attempt(function () { return Messages.services(); })
    ];
    for (var l = 0; l < lists.length; l++) {
      var list = lists[l];
      if (!list || typeof list.length !== 'number') continue;
      for (var i = 0; i < list.length; i++) all.push(list[i]);
    }
    var enabled = [];
    var unknown = [];
    for (var j = 0; j < all.length; j++) {
      var type = String(call(all[j], 'serviceType') || '');
      if (!/imessage/i.test(type)) continue;
      var on = call(all[j], 'enabled');
      if (on === false) continue;
      if (on === true) enabled.push(all[j]); else unknown.push(all[j]);
    }
    var found = enabled.concat(unknown);
    if (!found.length) { var e = new Error(NO_IMESSAGE); e.leashCode = 'no_imessage'; throw e; }
    return found;
  }

  function exists(ref) {
    if (!ref) return false;
    if (typeof ref.exists !== 'function') return true;
    return attempt(function () { return ref.exists(); }) === true;
  }

  // Ways to address a handle, most specific first. Checked references come before unchecked ones.
  function targetsFor(Messages, account, handle) {
    var id = call(account, 'id');
    var checked = [
      function () { return account.participants.byName(handle); },
      function () { return account.buddies.byName(handle); },
      function () { return Messages.participants.whose({ handle: handle })()[0]; },
      function () { return Messages.buddies.whose({ handle: handle })()[0]; }
    ];
    var unchecked = [
      function () { return Messages.accounts.byId(id).participants.byName(handle); },
      function () { return Messages.services.byId(id).buddies.byName(handle); },
      function () { return account.participants.byName(handle); },
      function () { return Messages.chats.byId('iMessage;-;' + handle); },
      function () { return Messages.chats.byId('any;-;' + handle); }
    ];
    var out = [];
    for (var i = 0; i < checked.length; i++) { var r = attempt(checked[i]); if (exists(r)) out.push(r); }
    for (var k = 0; k < unchecked.length; k++) { var u = attempt(unchecked[k]); if (u) out.push(u); }
    return out;
  }

  function sendTo(Messages, accounts, handle, body) {
    var lastError = null;
    for (var a = 0; a < accounts.length; a++) {
      var targets = targetsFor(Messages, accounts[a], handle);
      for (var t = 0; t < targets.length; t++) {
        try {
          Messages.send(body, { to: targets[t] });
          return;
        } catch (e) {
          if (e && e.errorNumber === -1743) throw e;
          lastError = e;
        }
      }
    }
    throw new Error('Could not send to ' + handle + (lastError ? ': ' + String(lastError.message || lastError) : ': no iMessage contact for that handle'));
  }

  try {
    var args = JSON.parse(argv[0] || '{}');
    var recipients = Array.isArray(args.recipients) ? args.recipients.map(String) : [];
    var body = String(args.text || '');
    if (!recipients.length) throw new Error('No recipients');
    if (!body) throw new Error('The text is empty');
    var Messages = Application(APP);
    var accounts = iMessageAccounts(Messages);
    var sent = 0;
    var failed = [];
    for (var i = 0; i < recipients.length; i++) {
      try {
        sendTo(Messages, accounts, recipients[i], body);
        sent++;
      } catch (e) {
        if (e && e.errorNumber === -1743) throw e;
        failed.push({ recipient: recipients[i], message: String((e && e.message) || e) });
      }
    }
    if (!sent && failed.length) {
      var all = new Error('No text was sent. ' + failed[0].message);
      all.leashCode = 'not_sent';
      throw all;
    }
    return JSON.stringify({ sent: sent, failed: failed });
  } catch (error) {
    return fail(error);
  }
}
