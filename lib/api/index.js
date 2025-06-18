const router = require("express").Router();

router.use("/outbound", require("./outbound"));
module.exports = router;
