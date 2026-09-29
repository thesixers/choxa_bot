import { getMikrotikClient, getRouterInfo } from '../src/mikrotik.js';

async function testMikroTikConnection() {
    const client = getMikrotikClient();
    console.log(`⏳ Connecting to MikroTik via HTTP at ${client.defaults.baseURL}...`);

    const info = await getRouterInfo();
    if (!info) {
        throw new Error("Unable to fetch router info. Check tunnel IP, port, and credentials.");
    }

    console.log('✅ Connected and authenticated via HTTP REST API!');
    console.log('\n📡 Router Identity:', info.identity);
    console.log('💻 System Resources:', {
        uptime:      info.uptime,
        version:     info.version,
        cpuLoad:     info.cpuLoad,
        freeMemory:  info.freeMemory,
        totalMemory: info.totalMemory,
    });
}

testMikroTikConnection()
    .then(() => {
        console.log('\n🎉 MikroTik HTTP test passed — WireGuard tunnel & REST API are working!');
        process.exit(0);
    })
    .catch((err) => {
        console.error(`\n❌ MikroTik test failed: ${err.message}`);
        process.exit(1);
    });
