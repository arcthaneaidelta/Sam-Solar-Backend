const express = require("express");
const JambonzClient = require("@jambonz/node-client");
const router = express.Router();

// Initialize Jambonz client
const client = JambonzClient(
  process.env.JAMBONZ_ACCOUNT_SID,
  process.env.JAMBONZ_API_KEY,
  {
    baseUrl:
      process.env.JAMBONZ_REST_API_BASE_URL || "https://api.jambonz.cloud/v1",
  },
);

/**
 * POST /api/outbound
 * Initiates an outbound call using the call-transfer-agent logic
 *

 * Request body:
 * {
 *   "to": "+1234567890",        // Required: Phone number to call
 *   "from": "+0987654321",      // Optional: Caller ID (defaults to env var)
 *   "callbackUrl": "https://...", // Optional: URL for call status updates
 *   "tag": { ... }              // Optional: Custom metadata to pass to the application
 * }
 */
router.post("/", async (req, res) => {
  const { logger } = req.app.locals;
  const { to, from, callbackUrl, tag, customer, metadata } = req.body;

  // Validate required fields
  if (!to) {
    return res.status(400).json({
      error: "Missing required field: to",
    });
  }

  // Validate phone number format (basic check)
  const phoneRegex = /^\+?[1-9]\d{1,14}$/;
  if (!phoneRegex.test(to)) {
    return res.status(400).json({
      error: "Invalid phone number format",
    });
  }

  try {
    logger.info({ to, from, tag, customer }, "Initiating outbound call");

    // Create the outbound call
    const callRequest = {
      from: from || process.env.FROM_NUMBER,
      to: {
        type: "phone",
        number: to,
        trunk: process.env.CARRIER,
      },
      application_sid: "64a1b9f8-da09-426f-8f0c-b19e435973cc",
    };

    // Add tag if provided
if (tag) {
  callRequest.tag = tag;
} else if (metadata) {
  callRequest.tag = metadata;
} else if (customer) {
  // If customer object is provided, use it as the tag
  callRequest.tag = { customer };
}

    const call = await client.calls.create(callRequest);

    logger.info({ callSid: call.sid }, "Outbound call initiated successfully");

    res.status(201).json({
      success: true,
      callSid: call.sid,
      message: "Outbound call initiated successfully",
      details: {
        to,
        from: from || process.env.FROM_NUMBER,
      },
    });
  } catch (error) {
    // Try to extract the actual error body from various possible locations
    let errorBody = null;
    if (error.response?.data) {
      errorBody = error.response.data;
    } else if (error.response?.body) {
      errorBody = error.response.body;
    } else if (error.body) {
      errorBody = error.body;
    } else if (error.message) {
      // Try to parse the message if it contains JSON
      try {
        errorBody = JSON.parse(error.message);
      } catch (e) {
        errorBody = error.message;
      }
    }

    logger.error(
      {
        error,
        errorMessage: error.message,
        errorStatus: error.status || error.statusCode,
        errorResponse: error.response?.data || error.response?.body,
        errorHeaders: error.headers,
        errorBody: errorBody,
        fullError: JSON.stringify(error),
      },
      "Failed to initiate outbound call",
    );

    // Handle specific Jambonz errors
    const status = error.status || error.statusCode;
    if (status === 401) {
      return res.status(401).json({
        error:
          "Authentication failed. Check JAMBONZ_ACCOUNT_SID and JAMBONZ_API_KEY",
      });
    } else if (status === 403) {
      return res.status(403).json({
        error: "Forbidden. Check account permissions and trunk configuration",
      });
    } else if (status === 404) {
      return res.status(404).json({
        error:
          "Jambonz resource not found. Check JAMBONZ_BASE_URL configuration",
      });
    }

    res.status(500).json({
      error: "Failed to initiate outbound call",
      message: error.message || "Internal server error",
      details: errorBody,
    });
  }
});

/**
 * GET /api/outbound/test
 * Test endpoint to verify Jambonz connection and configuration
 */
router.get("/test", async (req, res) => {
  const { logger } = req.app.locals;

  try {
    logger.info("Testing Jambonz connection and configuration");

    // Just return the configuration since we can't easily test the connection
    // The actual test will happen when we try to make a call
    res.json({
      success: true,
      message: "Configuration details",
      config: {
        accountSid: process.env.JAMBONZ_ACCOUNT_SID || "Not set",
        apiKey: process.env.JAMBONZ_API_KEY ? "Set" : "Not set",
        baseUrl:
          process.env.JAMBONZ_REST_API_BASE_URL ||
          "https://api.jambonz.cloud/v1",
        fromNumber: process.env.FROM_NUMBER || "Not configured",
        carrier: process.env.CARRIER || "Not configured",
        applicationSid: "64a1b9f8-da09-426f-8f0c-b19e435973cc",
      },
      required: {
        hasAccountSid: !!process.env.JAMBONZ_ACCOUNT_SID,
        hasApiKey: !!process.env.JAMBONZ_API_KEY,
        hasBaseUrl: !!process.env.JAMBONZ_REST_API_BASE_URL,
        hasFromNumber: !!process.env.FROM_NUMBER,
        hasCarrier: !!process.env.CARRIER,
      },
    });
  } catch (error) {
    logger.error({ error }, "Error in test endpoint");

    res.status(500).json({
      success: false,
      error: "Error in test endpoint",
      message: error.message,
    });
  }
});

/**
 * GET /api/outbound/:callSid
 * Get status of an outbound call
 */
router.get("/:callSid", async (req, res) => {
  const { logger } = req.app.locals;
  const { callSid } = req.params;

  try {
    const call = await client.calls.retrieve(callSid);

    res.json({
      success: true,
      call: call,
    });
  } catch (error) {
    logger.error({ error, callSid }, "Failed to get call status");

    if (error.status === 404) {
      return res.status(404).json({
        error: "Call not found",
      });
    }

    res.status(500).json({
      error: "Failed to get call status",
      message: error.message || "Internal server error",
    });
  }
});

/**
 * DELETE /api/outbound/:callSid
 * Terminate an active outbound call
 */
router.delete("/:callSid", async (req, res) => {
  const { logger } = req.app.locals;
  const { callSid } = req.params;

  try {
    await client.calls.update(callSid, {
      call_status: "completed",
    });

    logger.info({ callSid }, "Call terminated successfully");

    res.json({
      success: true,
      message: "Call terminated successfully",
      callSid,
    });
  } catch (error) {
    logger.error({ error, callSid }, "Failed to terminate call");

    if (error.status === 404) {
      return res.status(404).json({
        error: "Call not found",
      });
    }

    res.status(500).json({
      error: "Failed to terminate call",
      message: error.message || "Internal server error",
    });
  }
});

module.exports = router;
