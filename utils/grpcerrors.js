// utils/grpcerrors.js
/**
 * Heuristic detector for gRPC connectivity/availability failures.
 * Checks an error string against common substrings (e.g., "failed to connect",
 * "ECONNREFUSED", "connection timed out") and returns a boolean via isGrpcUnavailable().
 * Export: { isGrpcUnavailable }.
 */
function isGrpcUnavailable(errorText) {
    if (!errorText) return false;
    const patterns = [
        "Cannot establish connection to GRPC endpoint",
        "I/O error",
        "failed to connect",
        "ECONNREFUSED",
        "connection timed out",
        "unavailable"
    ];
    return patterns.some(pattern =>
        typeof errorText === 'string' && errorText.includes(pattern)
    );
}

module.exports = {
    isGrpcUnavailable
};