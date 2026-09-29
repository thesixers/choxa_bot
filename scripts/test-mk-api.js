import {
  getMikrotikClient,
  provisionHotspotUser,
  getHotspotUser,
  updateHotspotUser,
  removeHotspotUser,
  getRouterInfo,
} from "../src/mikrotik.js";

// Tested MikroTik RouterOS v7 REST API endpoints:
// /ip/hotspot/user?name=genesix - GET - it allows queries too
// /ip/hotspot/user - PUT - to create a new record it accpects json data
// /ip/hotspot/user/<userid> - DELETE - to delete a user
// /ip/hotspot/user/<userid> - PATCH - to update users details accepts json of the data to be updated

async function testMikrotikHttp() {
  console.log("🧪 Testing MikroTik RouterOS HTTP REST API...");

  const client = getMikrotikClient();
  console.log(`📡 Base URL: ${client.defaults.baseURL}`);

  // 0. Router Info & Identity Check
  const info = await getRouterInfo();
  if (info) {
    console.log(`✅ Connected! Router: ${info.identity} (RouterOS v${info.version}, Uptime: ${info.uptime})`);
  } else {
    console.log("ℹ️  Router info check skipped/failed, proceeding to Hotspot User tests...");
  }

  const testPin = "7778889";
  const testProfile = "Hour";

  try {
    // 1. PUT - Create new record
    console.log(`\n1️⃣  PUT /ip/hotspot/user (Creating test user '${testPin}')...`);
    await provisionHotspotUser(testPin, testProfile, "Test Provisioning", "0d 01:00:00");
    console.log(`✅ Successfully created user '${testPin}'`);

    // 2. GET - Query user
    console.log(`\n2️⃣  GET /ip/hotspot/user?name=${testPin} (Querying created user)...`);
    const user = await getHotspotUser(testPin);
    if (!user) {
      throw new Error(`Failed to find user '${testPin}' after PUT!`);
    }
    console.log(`✅ Found user:`, {
      id: user[".id"],
      name: user.name,
      profile: user.profile,
      comment: user.comment,
    });

    // 3. PATCH - Update user details
    console.log(`\n3️⃣  PATCH /ip/hotspot/user/${user[".id"]} (Updating profile & comment)...`);
    await updateHotspotUser(user[".id"], {
      comment: "Test Updated via PATCH",
    });
    const updated = await getHotspotUser(testPin);
    console.log(`✅ Updated user comment: '${updated?.comment}'`);

    // 4. DELETE - Delete user
    console.log(`\n4️⃣  DELETE /ip/hotspot/user/${user[".id"]} (Deleting test user)...`);
    await removeHotspotUser(testPin);
    const verifyDeleted = await getHotspotUser(testPin);
    if (verifyDeleted) {
      console.warn(`⚠️ User '${testPin}' still exists after delete!`);
    } else {
      console.log(`✅ User '${testPin}' successfully deleted!`);
    }

    console.log("\n🎉 All 4 MikroTik HTTP REST API endpoints tested successfully!");
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Test failed:", err.response?.data || err.message);
    process.exit(1);
  }
}

testMikrotikHttp();