// Spike 03: can a tiny command-line helper ask for Touch ID, and what does the prompt say?
// Build: swiftc 03-touchid.swift -o Leash
// Run:   ./Leash "send an email as you to alex@example.com"
// Exit codes: 0 approved, 1 denied or cancelled, 2 Touch ID unavailable (lid closed, not enrolled).

import Foundation
import LocalAuthentication

final class Outcome: @unchecked Sendable {
    var approved = false
    var message = ""
}

let arguments = Array(CommandLine.arguments.dropFirst())
let allowPassword = arguments.contains("--allow-password")
let reasonWords = arguments.filter { $0 != "--allow-password" }
let reason = reasonWords.isEmpty ? "approve this action" : reasonWords.joined(separator: " ")
let policy: LAPolicy = allowPassword ? .deviceOwnerAuthentication : .deviceOwnerAuthenticationWithBiometrics

let context = LAContext()
var availabilityError: NSError?
guard context.canEvaluatePolicy(policy, error: &availabilityError) else {
    print("unavailable: \(availabilityError?.localizedDescription ?? "unknown reason")")
    exit(2)
}

let outcome = Outcome()
let done = DispatchSemaphore(value: 0)
context.evaluatePolicy(policy, localizedReason: reason) { success, error in
    outcome.approved = success
    outcome.message = error?.localizedDescription ?? ""
    done.signal()
}
done.wait()

if outcome.approved {
    print("approved")
    exit(0)
}
print(outcome.message.isEmpty ? "denied" : "denied: \(outcome.message)")
exit(1)
