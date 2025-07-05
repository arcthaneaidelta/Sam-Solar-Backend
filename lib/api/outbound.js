const express = require("express");
const axios = require("axios");
const router = express.Router();

// Voximplant API configuration
const VOXIMPLANT_CONFIG = {
  accountId: process.env.VOXIMPLANT_ACCOUNT_ID,
  apiKey: process.env.VOXIMPLANT_API_KEY,
  applicationId: process.env.VOXIMPLANT_APPLICATION_ID,
  applicationName: process.env.VOXIMPLANT_APPLICATION_NAME,
  baseUrl: process.env.VOXIMPLANT_BASE_URL || "https://api.voximplant.com/platform_api/",
  sipTrunkName: process.env.VOXIMPLANT_SIP_TRUNK_NAME || "SIPIFICATION"
};

/**
 * Make authenticated request to Voximplant API
 */
async function voximplantRequest(endpoint, params = {}) {
  try {
    // Voximplant API uses POST with form-encoded data, not GET
    const formData = new URLSearchParams({
      account_id: VOXIMPLANT_CONFIG.accountId,
      api_key: VOXIMPLANT_CONFIG.apiKey,
      ...params
    });

    const response = await axios.post(
      `${VOXIMPLANT_CONFIG.baseUrl}${endpoint}`,
      formData.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    if (response.data.error) {
      throw new Error(`Voximplant API Error: ${response.data.error.msg || JSON.stringify(response.data.error)}`);
    }

    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(`Voximplant API Error: ${error.response.data.error?.msg || JSON.stringify(error.response.data)}`);
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
 *   "from": "+0987654321",      // Required: Caller ID from Sipification
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
    logger.info({ to, from, customer, metadata }, "Initiating Voximplant outbound call via SIP trunk");

    // Prepare custom data to pass to the scenario
    // This includes the destination number and all metadata
    const customData = {
      destination: to,  // The number to call
      callerId: from,   // The caller ID to use
      sipTrunk: VOXIMPLANT_CONFIG.sipTrunkName,
      ultravoxApiKey: process.env.ULTRAVOX_API_KEY, // Pass Ultravox API key securely
      customer: customer || {},
      metadata: metadata || {},
      originalTag: tag || {},
      callerInfo: {
        from: from,
        to: to
      }
    };

    // Check if Ultravox API key is available
    if (!process.env.ULTRAVOX_API_KEY) {
      logger.warn("ULTRAVOX_API_KEY not found in environment variables");
    }

    // FIXED: Don't use user_id for external calls - pass everything through custom data
    const callParams = {
      application_id: VOXIMPLANT_CONFIG.applicationId,
      rule_name: "outbound_ultravox", // Must exist in manage.voximplant.com
      script_custom_data: JSON.stringify(customData)
      // NO user_id or user_name - we're calling external numbers
    };

    logger.info({ 
      callParams,
      customDataSize: JSON.stringify(customData).length 
    }, "Voximplant call parameters prepared");

    const callResult = await voximplantRequest("StartScenarios", callParams);

    logger.info({ 
      sessionId: callResult.result?.[0]?.call_session_history_id,
      mediaSessionId: callResult.result?.[0]?.media_session_access_url 
    }, "Voximplant scenario started successfully");

    res.status(201).json({
      success: true,
      sessionId: callResult.result?.[0]?.call_session_history_id,
      message: "Outbound call initiated successfully via Voximplant/Sipification",
      details: {
        to,
        from,
        applicationId: VOXIMPLANT_CONFIG.applicationId,
        trunk: VOXIMPLANT_CONFIG.sipTrunkName
      }
    });

  } catch (error) {
    logger.error({
      error: error.message,
      stack: error.stack,
      voximplantConfig: {
        accountId: VOXIMPLANT_CONFIG.accountId,
        applicationId: VOXIMPLANT_CONFIG.applicationId,
        trunk: VOXIMPLANT_CONFIG.sipTrunkName,
        hasApiKey: !!VOXIMPLANT_CONFIG.apiKey
      }
    }, "Failed to initiate Voximplant outbound call");

    // Handle specific errors
    if (error.message.includes("authentication")) {
      return res.status(401).json({
        error: "Voximplant authentication failed. Check API credentials",
      });
    } else if (error.message.includes("application")) {
      return res.status(403).json({
        error: "Voximplant application error. Check application ID and rule configuration",
      });
    } else if (error.message.includes("rule")) {
      return res.status(404).json({
        error: "Rule 'outbound_ultravox' not found. Please create it in manage.voximplant.com",
      });
    }

    res.status(500).json({
      error: "Failed to initiate outbound call",
      message: error.message,
      hint: "Check Voximplant logs in manage.voximplant.com for detailed error information"
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

    // Check if required environment variables are set
    const configCheck = {
      hasAccountId: !!VOXIMPLANT_CONFIG.accountId,
      hasApiKey: !!VOXIMPLANT_CONFIG.apiKey,
      hasApplicationId: !!VOXIMPLANT_CONFIG.applicationId,
      hasApplicationName: !!VOXIMPLANT_CONFIG.applicationName,
      hasSipTrunkName: !!VOXIMPLANT_CONFIG.sipTrunkName
    };

    // Only proceed with API calls if configuration is complete
    if (!configCheck.hasAccountId || !configCheck.hasApiKey || !configCheck.hasApplicationId) {
      return res.status(500).json({
        success: false,
        error: "Missing required Voximplant configuration",
        configCheck,
        message: "Please set all required environment variables in Railway"
      });
    }

    // Test API connection
    const accountInfo = await voximplantRequest("GetAccountInfo");
    
    // Get application info
    const appInfo = await voximplantRequest("GetApplications", {
      application_id: VOXIMPLANT_CONFIG.applicationId
    });

    // Get rules to verify outbound_ultravox exists
    const rulesInfo = await voximplantRequest("GetRules", {
      application_id: VOXIMPLANT_CONFIG.applicationId
    });

    const outboundRule = rulesInfo.result?.find(r => r.rule_name === "outbound_ultravox");

    res.json({
      success: true,
      message: "Voximplant connection successful",
      config: {
        accountId: VOXIMPLANT_CONFIG.accountId,
        applicationId: VOXIMPLANT_CONFIG.applicationId,
        applicationName: VOXIMPLANT_CONFIG.applicationName,
        sipTrunk: VOXIMPLANT_CONFIG.sipTrunkName,
        hasApiKey: !!VOXIMPLANT_CONFIG.apiKey,
        outboundRuleExists: !!outboundRule,
        outboundRuleDetails: outboundRule || "Rule 'outbound_ultravox' not found - please create it"
      },
      voximplantData: {
        accountActive: accountInfo.result?.active,
        accountBalance: accountInfo.result?.balance,
        applicationName: appInfo.result?.[0]?.application_name,
        totalRules: rulesInfo.result?.length || 0
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
        sipTrunk: VOXIMPLANT_CONFIG.sipTrunkName,
        hasApiKey: !!VOXIMPLANT_CONFIG.apiKey
      }
    });
  }
});

/**
 * GET /api/outbound/:sessionId
 * Get status of a Voximplant call
 */
router.get("/:sessionId", async (req, res) => {
  const { logger } = req.app.locals;
  const { sessionId } = req.params;

  try {
    const callHistory = await voximplantRequest("GetCallHistory", {
      call_session_history_id: sessionId,
      with_calls: true,
      with_records: true
    });

    const callDetails = callHistory.result?.[0];
    
    res.json({
      success: true,
      call: {
        sessionId: callDetails?.call_session_history_id,
        startTime: callDetails?.start_date,
        duration: callDetails?.duration,
        cost: callDetails?.cost,
        customData: callDetails?.custom_data ? JSON.parse(callDetails.custom_data) : null,
        status: callDetails?.calls?.[0]?.successful ? "completed" : "failed",
        disconnectReason: callDetails?.calls?.[0]?.disconnect_reason
      }
    });

  } catch (error) {
    logger.error({ error: error.message, sessionId }, "Failed to get call status");

    if (error.message.includes("not found")) {
      return res.status(404).json({
        error: "Call session not found",
      });
    }

    res.status(500).json({
      error: "Failed to get call status",
      message: error.message,
    });
  }
});

module.exports = router;
