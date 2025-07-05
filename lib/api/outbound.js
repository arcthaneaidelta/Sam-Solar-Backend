const express = require("express");
const axios = require("axios");
const router = express.Router();

// Voximplant API configuration
const VOXIMPLANT_CONFIG = {
  accountId: process.env.VOXIMPLANT_ACCOUNT_ID,
  apiKey: process.env.VOXIMPLANT_API_KEY,
  applicationId: process.env.VOXIMPLANT_APPLICATION_ID,
  applicationName: process.env.VOXIMPLANT_APPLICATION_NAME,
  baseUrl: "https://api.voximplant.com/platform_api/"
};

/**
 * Make authenticated request to Voximplant API
 */
async function voximplantRequest(endpoint, params = {}) {
  try {
    // Voximplant API uses GET requests with query parameters
    const queryParams = new URLSearchParams({
      account_id: VOXIMPLANT_CONFIG.accountId,
      api_key: VOXIMPLANT_CONFIG.apiKey,
      ...params
    });

    const response = await axios.get(`${VOXIMPLANT_CONFIG.baseUrl}${endpoint}?${queryParams}`);

    if (response.data.error) {
      throw new Error(`Voximplant API Error: ${response.data.error.msg || response.data.error}`);
    }

    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(`Voximplant API Error: ${error.response.data.error?.msg || error.response.data}`);
    }
    throw error;
  }
}

/**
 * Validate phone number format
 */
function validatePhoneNumber(phoneNumber) {
  if (!phoneNumber) return false;
  // Basic international phone number validation
  const phoneRegex = /^\+?[1-9]\d{1,14}$/;
  return phoneRegex.test(phoneNumber);
}

/**
 * POST /api/outbound
 * Initiates an outbound call using Voximplant
 * 
 * Request body:
 * {
 *   "to": "+1234567890",        // Required: Phone number to call
 *   "from": "+0987654321",      // Optional: Caller ID (defaults to random from pool)
 *   "customer": { ... },        // Optional: Customer metadata
 *   "metadata": { ... }         // Optional: Additional metadata
 * }
 */
router.post("/", async (req, res) => {
  const { logger } = req.app.locals;
  const { to, from, customer, metadata, tag } = req.body;

  // Validate required fields
  if (!to) {
    return res.status(400).json({
      error: "Missing required field: to",
    });
  }

  if (!from) {
    return res.status(400).json({
      error: "Missing required field: from (caller ID must be specified)",
    });
  }

  // Validate phone number formats
  if (!validatePhoneNumber(to)) {
    return res.status(400).json({
      error: "Invalid 'to' phone number format",
    });
  }

  if (!validatePhoneNumber(from)) {
    return res.status(400).json({
      error: "Invalid 'from' phone number format",
    });
  }

  try {
    logger.info({ to, from, customer, metadata }, "Initiating Voximplant outbound call");

    // Use the specified 'from' number directly (from Sipification carrier)
    const callerNumber = from;

    // Prepare custom data to pass to the scenario
    const customData = {
      customer: customer || {},
      metadata: metadata || {},
      originalTag: tag || {},
      callerInfo: {
        from: callerNumber,
        to: to
      }
    };

    // Start outbound call using Voximplant API
    const callParams = {
      user_name: to.replace(/^\+/, ""), // Remove + prefix for Voximplant
      application_id: VOXIMPLANT_CONFIG.applicationId,
      rule_name: "outbound_ultravox", // This rule should exist in manage.voximplant.com
      script_custom_data: JSON.stringify(customData),
      caller_id: callerNumber, // Use the exact 'from' number provided in the request
      // Additional SIP headers for better routing through Sipification trunk
      sip_headers: JSON.stringify({
        "X-Customer-Data": JSON.stringify(customData),
        "X-Caller-Source": "sipification-trunk"
      })
    };

    const callResult = await voximplantRequest("StartScenarios", callParams);

    logger.info({ 
      callId: callResult.result?.[0]?.call_session_history_id,
      mediaSessionId: callResult.result?.[0]?.media_session_access_url 
    }, "Voximplant call initiated successfully");

    res.status(201).json({
      success: true,
      callId: callResult.result?.[0]?.call_session_history_id,
      mediaSessionId: callResult.result?.[0]?.media_session_access_url,
      message: "Outbound call initiated successfully via Voximplant",
      details: {
        to,
        from: callerNumber,
        applicationId: VOXIMPLANT_CONFIG.applicationId
      },
      voximplantResponse: callResult
    });

  } catch (error) {
    logger.error({
      error: error.message,
      stack: error.stack,
      voximplantConfig: {
        accountId: VOXIMPLANT_CONFIG.accountId,
        applicationId: VOXIMPLANT_CONFIG.applicationId,
        hasApiKey: !!VOXIMPLANT_CONFIG.apiKey
      }
    }, "Failed to initiate Voximplant outbound call");

    // Handle specific Voximplant errors
    if (error.message.includes("authentication")) {
      return res.status(401).json({
        error: "Voximplant authentication failed. Check VOXIMPLANT_API_KEY and VOXIMPLANT_ACCOUNT_ID",
      });
    } else if (error.message.includes("application")) {
      return res.status(403).json({
        error: "Voximplant application error. Check VOXIMPLANT_APPLICATION_ID configuration",
      });
    }

    res.status(500).json({
      error: "Failed to initiate outbound call via Voximplant",
      message: error.message,
      details: {
        accountId: VOXIMPLANT_CONFIG.accountId,
        applicationId: VOXIMPLANT_CONFIG.applicationId
      }
    });
  }
});

/**
 * GET /api/outbound/test
 * Test endpoint to verify Voximplant connection and configuration
 */
router.get("/test", async (req, res) => {
  const { logger } = req.app.locals;

  try {
    logger.info("Testing Voximplant connection and configuration");

    // Test API connection by getting account info
    const accountInfo = await voximplantRequest("GetAccountInfo");
    
    // Test application info
    const appInfo = await voximplantRequest("GetApplications", {
      application_id: VOXIMPLANT_CONFIG.applicationId
    });

    res.json({
      success: true,
      message: "Voximplant connection successful",
      config: {
        accountId: VOXIMPLANT_CONFIG.accountId,
        applicationId: VOXIMPLANT_CONFIG.applicationId,
        applicationName: VOXIMPLANT_CONFIG.applicationName,
        hasApiKey: !!VOXIMPLANT_CONFIG.apiKey,
        sipificationTrunkConfigured: true, // We know the trunk exists in Kit
        usesCarrierNumbers: true // Numbers come from Sipification carrier
      },
      voximplantData: {
        account: accountInfo.result,
        application: appInfo.result?.[0]
      }
    });

  } catch (error) {
    logger.error({ error: error.message }, "Voximplant test failed");

    res.status(500).json({
      success: false,
      error: "Voximplant connection test failed",
      message: error.message,
      config: {
        accountId: VOXIMPLANT_CONFIG.accountId,
        applicationId: VOXIMPLANT_CONFIG.applicationId,
        hasApiKey: !!VOXIMPLANT_CONFIG.apiKey,
        sipificationTrunkConfigured: true
      }
    });
  }
});

/**
 * GET /api/outbound/:callId
 * Get status of a Voximplant call
 */
router.get("/:callId", async (req, res) => {
  const { logger } = req.app.locals;
  const { callId } = req.params;

  try {
    const callHistory = await voximplantRequest("GetCallHistory", {
      call_session_history_id: callId
    });

    res.json({
      success: true,
      call: callHistory.result?.[0] || null,
    });

  } catch (error) {
    logger.error({ error: error.message, callId }, "Failed to get Voximplant call status");

    if (error.message.includes("not found")) {
      return res.status(404).json({
        error: "Call not found",
      });
    }

    res.status(500).json({
      error: "Failed to get call status",
      message: error.message,
    });
  }
});

/**
 * DELETE /api/outbound/:callId
 * Terminate an active Voximplant call
 */
router.delete("/:callId", async (req, res) => {
  const { logger } = req.app.locals;
  const { callId } = req.params;

  try {
    // Voximplant uses TerminateCall for ending active calls
    await voximplantRequest("TerminateCall", {
      call_session_history_id: callId
    });

    logger.info({ callId }, "Voximplant call terminated successfully");

    res.json({
      success: true,
      message: "Call terminated successfully",
      callId,
    });

  } catch (error) {
    logger.error({ error: error.message, callId }, "Failed to terminate Voximplant call");

    if (error.message.includes("not found")) {
      return res.status(404).json({
        error: "Call not found",
      });
    }

    res.status(500).json({
      error: "Failed to terminate call",
      message: error.message,
    });
  }
});

module.exports = router;
