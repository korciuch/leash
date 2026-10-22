// Spike 02: does a native approval dialog appear on top, read clearly, and default to Deny?
// Run: osascript -l JavaScript 02-approval-dialog.js
// Then: sleep 3 && osascript -l JavaScript 02-approval-dialog.js   (switch to Claude Desktop during the 3 seconds)

function run(argv) {
  const message = argv[0] || 'Claude wants to send a Messages text to 14 contacts:\n\n"Check out this link"\n\nNo permission covers this.';
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  const started = Date.now();
  app.activate();
  try {
    const reply = app.displayDialog(message, {
      withTitle: 'Leash',
      buttons: ['Deny', 'Allow once', 'Allow for 1 hour'],
      defaultButton: 'Deny',
      withIcon: 'caution',
      givingUpAfter: 60
    });
    return JSON.stringify({ decision: reply.gaveUp ? 'Deny (timed out)' : reply.buttonReturned, secondsOpen: Math.round((Date.now() - started) / 1000) });
  } catch (error) {
    return JSON.stringify({ decision: 'Deny (dialog closed)', error: String(error) });
  }
}
