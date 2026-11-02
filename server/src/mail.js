// A tiny mail-service interface. Anything with `send(message)` is a mailer, where a message is
//   { to, kind, subject, text, link? }
// `kind` is a short machine name ('verify', 'password-reset', 'new-device', ...) so a real provider can pick a template.
//
// No provider is connected yet, so the default mailer prints to the server console. To connect a real one,
// write an object with the same `send` method (SES, SendGrid, SMTP, ...) and pass it to createApp as `mailer`.

export function consoleMailer(log = console.log) {
  return {
    send({ to, kind, subject, text, link }) {
      log(`[email] ${kind} ${to}: ${link ?? text ?? subject}`);
    },
  };
}

// Sends without ever throwing into the request: a mail failure must not break a login or a reset.
export function deliver(mailer, message, onError = console.error) {
  try {
    Promise.resolve(mailer.send(message)).catch((e) => onError(`[email] failed to send ${message.kind}:`, e));
  } catch (e) {
    onError(`[email] failed to send ${message.kind}:`, e);
  }
}
