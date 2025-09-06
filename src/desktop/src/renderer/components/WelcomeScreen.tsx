import React, { useState, useEffect } from "react";
import icon from "../../../assets/icon.svg";
import "./WelcomeScreen.css";

interface WelcomeScreenProps {
  onAuthSuccess: () => void;
}

export default function WelcomeScreen({
  onAuthSuccess,
}: WelcomeScreenProps): React.ReactElement {
  const [isLoading, setIsLoading] = useState(false);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Set up device code listener
    const removeListener = window.electron.auth.onDeviceCode((code: string) => {
      setDeviceCode(code);
    });

    return () => {
      removeListener();
    };
  }, []);

  const handleLogin = async () => {
    setIsLoading(true);
    setError(null);
    setDeviceCode(null);

    try {
      const result = await window.electron.auth.login();
      if (result.success) {
        onAuthSuccess();
      } else {
        setError(result.error || "Authentication failed. Please try again.");
      }
    } catch (err) {
      setError("Authentication failed. Please try again.");
      console.error("Authentication error:", err);
    } finally {
      setIsLoading(false);
      setDeviceCode(null);
    }
  };

  return (
    <div className="welcome-screen">
      <div className="welcome-content">
        <img width="120" alt="Checkpoint Logo" src={icon} className="logo" />
        <h1>Welcome to Checkpoint</h1>
        <p>Version control system for large files and repositories</p>

        {!deviceCode && !isLoading && (
          <div className="auth-section">
            <p>Get started by signing in to your account</p>
            <button
              type="button"
              onClick={handleLogin}
              className="login-button"
              disabled={isLoading}
            >
              Sign In
            </button>
          </div>
        )}

        {isLoading && !deviceCode && (
          <div className="loading-section">
            <div className="spinner"></div>
            <p>Connecting...</p>
          </div>
        )}

        {deviceCode && (
          <div className="device-code-section">
            <h3>Device Authentication</h3>
            <p>A browser window has opened. Please enter this code:</p>
            <div className="device-code">{deviceCode}</div>
            <p className="code-instruction">
              Complete the authentication in your browser, then return here.
            </p>
            <div className="spinner"></div>
            <p>Waiting for authentication...</p>
          </div>
        )}

        {error && (
          <div className="error-section">
            <p className="error-message">{error}</p>
            <button
              type="button"
              onClick={handleLogin}
              className="retry-button"
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
