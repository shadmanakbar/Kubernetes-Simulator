const express = require("express");
const config = require("config");
const {
  generateUserLoad,
  UserSession,
  simulatePodUsage,
  calculateAverageUsage,
  distributeUsers,
  scaleReplicas,
  resetSimulation
} = require("../scalingLogic");

const router = express.Router();
let simulationInterval;
let pods = [];
let users = [];
let simulationStartTime = null;

class Pod {
  constructor(name, resources) {
    this.name = name;
    this.resources = resources;
    this.metrics = [];
    this.status = 'Running';
    this.startTime = new Date().toISOString();
    this.restarts = 0;
    this.lastError = null;
    this.restartingAt = null;
  }

  crash(reason) {
    this.status = 'CrashLoopBackOff';
    this.lastError = reason;
    this.restartingAt = new Date(Date.now() + 10000); // 10 seconds restart delay
    this.restarts++;
  }

  restart() {
    this.status = 'Running';
    this.startTime = new Date().toISOString();
    this.lastError = null;
    this.restartingAt = null;
  }
}

let runtimeConfig = {
  minReplicas: 1,
  maxReplicas: 10,
  cpuThreshold: 60,
  memoryThreshold: 60,
  podResources: {
    requests: {
      cpu: "1000m",
      memory: "4Gi"
    },
    limits: {
      cpu: "4000m",
      memory: "5Gi"
    }
  },
  userResources: {
    cpu: 0.5,    // 0.5% CPU per user
    memory: 1.0  // 1.0% Memory per user
  },
  defaultLoadProfile: {
    pattern: "random",
    baseLoad: 100,
    amplitude: 200,
    period: 10,
    initialUsers: 100,
    maxUsers: 1000,
    userGrowthRate: 200,
    spikeProbability: 0.1,
    spikeMultiplier: 2.0
  },
  userPatterns: {
    light: {
      cpu: 0.1,
      memory: 0.7
    },
    medium: {
      cpu: 0.5,
      memory: 1.0
    },
    heavy: {
      cpu: 0.8,
      memory: 1.5
    }
  },
  simulationInterval: 5000
};

function initializePods(count) {
  pods = Array.from({ length: count }, (_, i) => 
    new Pod(`pod-${i + 1}`, runtimeConfig.podResources)
  );
}

function simulateUserActivity(runtimeConfig) {
  const currentTime = Date.now() / 1000;
  const userTypes = ['light', 'medium', 'heavy'];
  
  let targetUsers;
  
  if (runtimeConfig.defaultLoadProfile.pattern === 'linear') {
    // For linear pattern, calculate based on elapsed time
    const elapsedMinutes = Math.floor((currentTime - simulationStartTime) / 60);
    targetUsers = Math.min(
      runtimeConfig.defaultLoadProfile.maxUsers,
      runtimeConfig.defaultLoadProfile.baseLoad + 
      (runtimeConfig.defaultLoadProfile.userGrowthRate * elapsedMinutes)
    );
    
    console.log('Linear Pattern:', {
      elapsedMinutes,
      baseLoad: runtimeConfig.defaultLoadProfile.baseLoad,
      targetUsers,
      maxUsers: runtimeConfig.defaultLoadProfile.maxUsers,
      growthRate: runtimeConfig.defaultLoadProfile.userGrowthRate
    });
  } else {
    // For other patterns
    targetUsers = Math.floor(
      runtimeConfig.defaultLoadProfile.baseLoad + 
      (Math.sin(currentTime / 10000) + 1) * runtimeConfig.defaultLoadProfile.userGrowthRate
    );
  }

  // Ensure we never exceed maxUsers
  targetUsers = Math.min(targetUsers, runtimeConfig.defaultLoadProfile.maxUsers);
  
  // Adjust user count
  while (users.length < targetUsers) {
    users.push(new UserSession(
      `user-${users.length + 1}`,
      userTypes[Math.floor(Math.random() * userTypes.length)]
    ));
  }

  while (users.length > targetUsers) {
    users.pop();
  }

  return users;
}

router.get("/config", (req, res) => {
  try {
    res.json(runtimeConfig);
  } catch (err) {
    console.error("Error fetching config:", err);
    res.status(500).json({ error: "Failed to fetch configuration" });
  }
});

router.post("/start", (req, res) => {
  simulationStartTime = Date.now() / 1000;  // Set start time
  initializePods(runtimeConfig.minReplicas);
  users = [];  // Reset users

  if (simulationInterval) {
    clearInterval(simulationInterval);
  }

  simulationInterval = setInterval(() => {
    const currentTime = new Date();
    pods.forEach(pod => {
      if (pod.status === 'CrashLoopBackOff' && pod.restartingAt && currentTime >= pod.restartingAt) {
        pod.restart();
      }
    });

    const runningPods = pods.filter(pod => pod.status === 'Running');

    if (runningPods.length === 0 && pods.length > 0) {
      const oldestCrashedPod = pods
        .filter(pod => pod.status === 'CrashLoopBackOff')
        .sort((a, b) => new Date(a.restartingAt) - new Date(b.restartingAt))[0];
      
      if (oldestCrashedPod) {
        oldestCrashedPod.restart();
        runningPods.push(oldestCrashedPod);
      }
    }

    const activeUsers = simulateUserActivity(runtimeConfig);
    
    const podsMetrics = pods.map(pod => {
      if (pod.status !== 'Running') return null;
      
      const metrics = simulatePodUsage(pod, activeUsers, runtimeConfig);
      
      console.log(`Pod ${pod.name} calculated metrics:`, metrics);
      
      if (metrics.cpu >= 99) {
        pod.crash('CPU Exhaustion');
      } else if (metrics.memory >= 99) {
        pod.crash('Memory Exhaustion');
      }
      
      return metrics;
    }).filter(Boolean);
    
    const avgUsage = calculateAverageUsage(podsMetrics);

    const newReplicaCount = scaleReplicas(
      pods.length,
      avgUsage.cpu,
      avgUsage.memory,
      activeUsers.length,
      runtimeConfig
    );

    if (newReplicaCount > pods.length) {
      while (pods.length < newReplicaCount) {
        pods.push(new Pod(`pod-${pods.length + 1}`, runtimeConfig.podResources));
      }
    } else if (newReplicaCount < pods.length && runningPods.length > newReplicaCount) {
      const podsToRemove = runningPods
        .filter(pod => !pod.metrics || pod.metrics.cpu < 80)
        .slice(-(pods.length - newReplicaCount));
      
      pods = pods.filter(pod => !podsToRemove.includes(pod));
    }

    distributeUsers(activeUsers, runningPods);

    req.app.get('wss').clients.forEach(client => {
      client.send(JSON.stringify({
        timestamp: new Date().toISOString(),
        pods: pods.map(pod => ({
          name: pod.name,
          status: pod.status,
          metrics: podsMetrics.find(m => m?.podName === pod.name),
          resources: pod.resources,
          activeUsers: activeUsers.filter(u => u.podName === pod.name).map(u => ({
            id: u.id,
            type: u.type
          })),
          restarts: pod.restarts,
          lastError: pod.lastError,
          restartingAt: pod.restartingAt
        })),
        averages: avgUsage,
        totalUsers: activeUsers.length
      }));
    });
  }, runtimeConfig.simulationInterval);

  res.json({ message: "Simulation started", initialPods: pods });
});

router.post("/stop", (req, res) => {
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }
  simulationStartTime = null;  // Reset start time
  pods = [];
  users = [];
  res.json({ message: "Simulation stopped" });
});

router.post("/config", (req, res) => {
  try {
    const newConfig = req.body;
    
    // Validate the new configuration
    if (newConfig.minReplicas > newConfig.maxReplicas) {
      return res.status(400).json({ 
        error: "Minimum replicas cannot be greater than maximum replicas" 
      });
    }

    // If changing to linear pattern, reset simulation
    if (newConfig.defaultLoadProfile?.pattern === 'linear' && 
        runtimeConfig.defaultLoadProfile.pattern !== 'linear') {
      simulationStartTime = Date.now() / 1000;
      users = [];
    }

    // Deep merge the configuration
    runtimeConfig = {
      ...runtimeConfig,
      minReplicas: newConfig.minReplicas,
      maxReplicas: newConfig.maxReplicas,
      cpuThreshold: newConfig.cpuThreshold,
      memoryThreshold: newConfig.memoryThreshold,
      userResources: {
        ...runtimeConfig.userResources,
        ...newConfig.userResources
      },
      podResources: {
        requests: {
          ...runtimeConfig.podResources.requests,
          ...newConfig.podResources?.requests
        },
        limits: {
          ...runtimeConfig.podResources.limits,
          ...newConfig.podResources?.limits
        }
      },
      defaultLoadProfile: {
        ...runtimeConfig.defaultLoadProfile,
        ...newConfig.defaultLoadProfile
      }
    };

    // Restart simulation with new configuration if it's running
    if (simulationInterval) {
      clearInterval(simulationInterval);
      
      // Update existing pods with new resource configuration
      pods.forEach(pod => {
        pod.resources = runtimeConfig.podResources;
      });

      // Adjust pod count if needed
      while (pods.length < runtimeConfig.minReplicas) {
        pods.push(new Pod(`pod-${pods.length + 1}`, runtimeConfig.podResources));
      }
      while (pods.length > runtimeConfig.maxReplicas) {
        pods.pop();
      }

      // Restart simulation interval
      simulationInterval = setInterval(() => {
        const currentTime = new Date();
        pods.forEach(pod => {
          if (pod.status === 'CrashLoopBackOff' && pod.restartingAt && currentTime >= pod.restartingAt) {
            pod.restart();
          }
        });

        const runningPods = pods.filter(pod => pod.status === 'Running');
        if (runningPods.length === 0 && pods.length > 0) {
          const oldestCrashedPod = pods
            .filter(pod => pod.status === 'CrashLoopBackOff')
            .sort((a, b) => new Date(a.restartingAt) - new Date(b.restartingAt))[0];
          
          if (oldestCrashedPod) {
            oldestCrashedPod.restart();
            runningPods.push(oldestCrashedPod);
          }
        }

        const activeUsers = simulateUserActivity(runtimeConfig);
        
        const podsMetrics = pods.map(pod => {
          if (pod.status !== 'Running') return null;
          
          const metrics = simulatePodUsage(pod, activeUsers, runtimeConfig);
          
          console.log(`Pod ${pod.name} calculated metrics:`, metrics);
          
          if (metrics.cpu >= 99) {
            pod.crash('CPU Exhaustion');
          } else if (metrics.memory >= 99) {
            pod.crash('Memory Exhaustion');
          }
          
          return metrics;
        }).filter(Boolean);
        
        const avgUsage = calculateAverageUsage(podsMetrics);

        const newReplicaCount = scaleReplicas(
          pods.length,
          avgUsage.cpu,
          avgUsage.memory,
          activeUsers.length,
          runtimeConfig
        );

        if (newReplicaCount > pods.length) {
          while (pods.length < newReplicaCount) {
            pods.push(new Pod(`pod-${pods.length + 1}`, runtimeConfig.podResources));
          }
        } else if (newReplicaCount < pods.length && runningPods.length > newReplicaCount) {
          const podsToRemove = runningPods
            .filter(pod => !pod.metrics || pod.metrics.cpu < 80)
            .slice(-(pods.length - newReplicaCount));
          
          pods = pods.filter(pod => !podsToRemove.includes(pod));
        }

        distributeUsers(activeUsers, runningPods);

        req.app.get('wss').clients.forEach(client => {
          client.send(JSON.stringify({
            timestamp: new Date().toISOString(),
            pods: pods.map(pod => ({
              name: pod.name,
              status: pod.status,
              metrics: podsMetrics.find(m => m?.podName === pod.name),
              resources: pod.resources,
              activeUsers: activeUsers.filter(u => u.podName === pod.name).map(u => ({
                id: u.id,
                type: u.type
              })),
              restarts: pod.restarts,
              lastError: pod.lastError,
              restartingAt: pod.restartingAt
            })),
            averages: avgUsage,
            totalUsers: activeUsers.length
          }));
        });
      }, runtimeConfig.simulationInterval);
    }

    res.json({ 
      message: "Configuration updated successfully",
      config: runtimeConfig 
    });
  } catch (err) {
    console.error("Error updating config:", err);
    res.status(500).json({ error: "Failed to update configuration" });
  }
});

router.get("/status", (req, res) => {
  try {
    res.json({
      isRunning: !!simulationInterval,
      activePods: pods.length,
      activeUsers: users.length,
      config: runtimeConfig
    });
  } catch (err) {
    console.error("Error fetching status:", err);
    res.status(500).json({ error: "Failed to fetch simulation status" });
  }
});

module.exports = router;
