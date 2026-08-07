// Ad-hoc sign the app so it runs on Apple Silicon without a Developer ID cert.
const { execSync } = require("node:child_process");

exports.default = async function (context) {
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: "inherit" });
};
