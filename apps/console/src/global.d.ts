// SPDX-License-Identifier: MIT

/** Allow importing shell scripts, config files, and pubkeys as strings
 *  (used by @ellul.ai/api provisioning) */
declare module '*.sh' {
  const content: string;
  export default content;
}
declare module '*.conf' {
  const content: string;
  export default content;
}
declare module '*.pub' {
  const content: string;
  export default content;
}
