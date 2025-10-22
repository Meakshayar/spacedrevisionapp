const { MongoClient } = require('mongodb');

let cachedClient = null;

async function connectToDatabase() {
    if (cachedClient) {
        return cachedClient;
    }
    
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    cachedClient = client;
    return client;
}

exports.handler = async (event, context) => {
    // Handle CORS - allow requests from any origin
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    };

    // Handle preflight requests
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    try {
        const client = await connectToDatabase();
        const db = client.db('psc_app');
        const collection = db.collection('app_data');

        if (event.httpMethod === 'GET') {
            // Send latest data to client
            const data = await collection.findOne({ _id: 'main' });
            
            // If no data exists, return empty structure
            if (!data) {
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        questionSets: {},
                        playerProfiles: {},
                        dailyRevisionScores: {},
                        practiceHistory: {},
                        revisionProgress: {},
                        reportedQuestions: [],
                        lastUpdated: new Date().toISOString()
                    })
                };
            }
            
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify(data)
            };
        }

        if (event.httpMethod === 'POST') {
            // Receive updates from client
            const incomingData = JSON.parse(event.body);
            
            console.log('📨 Received data from client:', {
                players: Object.keys(incomingData.playerProfiles || {}).length,
                sets: Object.keys(incomingData.questionSets || {}).length
            });
            
            // Get existing data
            const existingData = await collection.findOne({ _id: 'main' }) || {};
            
            // Smart merge - preserve all data, don't overwrite
            const mergedData = {
                _id: 'main',
                // Question sets: new ones get added, existing ones stay
                questionSets: { ...existingData.questionSets, ...incomingData.questionSets },
                // Player profiles: merge, but don't overwrite existing players with lower XP
                playerProfiles: { ...existingData.playerProfiles },
                dailyRevisionScores: { ...existingData.dailyRevisionScores },
                practiceHistory: { ...existingData.practiceHistory },
                revisionProgress: { ...existingData.revisionProgress },
                reportedQuestions: [...(existingData.reportedQuestions || [])],
                lastUpdated: new Date().toISOString()
            };

            // Smart merge player profiles - keep highest XP version
            Object.keys(incomingData.playerProfiles || {}).forEach(player => {
                const existingPlayer = existingData.playerProfiles?.[player];
                const incomingPlayer = incomingData.playerProfiles[player];
                
                if (!existingPlayer || (incomingPlayer.totalXP > (existingPlayer.totalXP || 0))) {
                    mergedData.playerProfiles[player] = incomingPlayer;
                }
            });

            // Merge daily scores - sum them up
            Object.keys(incomingData.dailyRevisionScores || {}).forEach(date => {
                if (!mergedData.dailyRevisionScores[date]) {
                    mergedData.dailyRevisionScores[date] = {};
                }
                Object.keys(incomingData.dailyRevisionScores[date]).forEach(player => {
                    mergedData.dailyRevisionScores[date][player] = 
                        (mergedData.dailyRevisionScores[date][player] || 0) + 
                        incomingData.dailyRevisionScores[date][player];
                });
            });

            // Merge practice history - keep all attempts
            Object.keys(incomingData.practiceHistory || {}).forEach(key => {
                if (!mergedData.practiceHistory[key]) {
                    mergedData.practiceHistory[key] = incomingData.practiceHistory[key];
                }
            });

            // Merge revision progress - incoming data wins for conflicts
            Object.keys(incomingData.revisionProgress || {}).forEach(player => {
                if (!mergedData.revisionProgress[player]) {
                    mergedData.revisionProgress[player] = {};
                }
                Object.keys(incomingData.revisionProgress[player]).forEach(key => {
                    mergedData.revisionProgress[player][key] = incomingData.revisionProgress[player][key];
                });
            });

            // Merge reported questions - avoid duplicates
            (incomingData.reportedQuestions || []).forEach(newReport => {
                const exists = mergedData.reportedQuestions.some(
                    existingReport => existingReport.reportId === newReport.reportId
                );
                if (!exists) {
                    mergedData.reportedQuestions.push(newReport);
                }
            });

            // Save to database
            await collection.updateOne(
                { _id: 'main' },
                { $set: mergedData },
                { upsert: true }
            );

            console.log('💾 Saved to database:', {
                players: Object.keys(mergedData.playerProfiles).length,
                sets: Object.keys(mergedData.questionSets).length
            });

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ 
                    success: true, 
                    message: 'Data synced successfully',
                    stats: {
                        players: Object.keys(mergedData.playerProfiles).length,
                        sets: Object.keys(mergedData.questionSets).length
                    }
                })
            };
        }

        // Method not allowed
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };

    } catch (error) {
        console.error('❌ Sync error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
                error: 'Internal server error',
                message: error.message 
            })
        };
    }
};
