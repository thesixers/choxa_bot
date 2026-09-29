import { removeActiveSessions, getActiveSessions } from "../src/mikrotik.js";

const testRemoval = async (username) => {
  console.log(`🔍 Checking active sessions for '${username}'...`);
  const sessions = await getActiveSessions(username);
  console.log(`Found ${sessions.length} active session(s):`, sessions);

  const count = await removeActiveSessions(username);
  console.log(`✅ Result: ${count} session(s) removed.`);
};

testRemoval("Az_0");
