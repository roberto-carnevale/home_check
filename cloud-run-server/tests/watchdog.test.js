// We want to use Jest's fake timers to test setTimeout without actually waiting
// This makes tests run instantaneously instead of taking 95 minutes
jest.useFakeTimers();

// Mock the mailer and webpush services
// We do this to intercept their function calls without sending real emails/pushes
jest.mock('../src/services/mailer', () => ({
    sendAlert: jest.fn()
}));
jest.mock('../src/services/webpush', () => ({
    sendPushToAll: jest.fn()
}));

// Import the mocked dependencies and the watchdog module
// This allows us to assert that the mocks were called by the watchdog
const mailer = require('../src/services/mailer');
const webpush = require('../src/services/webpush');
const watchdog = require('../src/services/watchdog');

// Define the test suite for the Watchdog Service
// This ensures our emergency alerting system works
describe('Watchdog Service', () => {

    // Before each test, clear any mock data and stop the watchdog
    // This provides a clean slate for every test case
    beforeEach(() => {
        jest.clearAllMocks();
        watchdog.stopWatchdog();
    });

    // Test case: The watchdog fires if the timer runs out
    it('should fire alerts after timeout', () => {
        // Start the watchdog timer
        watchdog.resetWatchdog();

        // At this point, the alert functions should not have been called yet
        expect(mailer.sendAlert).not.toHaveBeenCalled();
        expect(webpush.sendPushToAll).not.toHaveBeenCalled();

        // Fast-forward time by exactly 95 minutes (in milliseconds)
        // This triggers any pending setTimeouts
        jest.advanceTimersByTime(95 * 60 * 1000);

        // Now, we expect both alerting functions to have been called once
        // This proves the watchdog fired correctly
        expect(mailer.sendAlert).toHaveBeenCalledTimes(1);
        expect(webpush.sendPushToAll).toHaveBeenCalledTimes(1);
    });

    // Test case: Resetting the watchdog cancels the previous timer
    it('should cancel previous timer when reset', () => {
        // Start the watchdog timer
        watchdog.resetWatchdog();

        // Fast-forward 50 minutes (not enough to trigger)
        jest.advanceTimersByTime(50 * 60 * 1000);

        // Reset the watchdog because we (hypothetically) received new data
        // This should clear the old timer and start a new 95-minute countdown
        watchdog.resetWatchdog();

        // Fast-forward another 50 minutes
        // The total elapsed time is 100m, but since we reset at 50m,
        // the new timer still has 45m remaining. It should NOT fire yet.
        jest.advanceTimersByTime(50 * 60 * 1000);
        expect(mailer.sendAlert).not.toHaveBeenCalled();

        // Fast-forward another 50 minutes (total 100m since reset)
        // Now the second timer should definitely fire
        jest.advanceTimersByTime(50 * 60 * 1000);
        expect(mailer.sendAlert).toHaveBeenCalledTimes(1);
    });
});
