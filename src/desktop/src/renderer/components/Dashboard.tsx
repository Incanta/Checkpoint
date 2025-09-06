import React from "react";
import icon from "../../../assets/icon.svg";
import "./Dashboard.css";

interface DashboardProps {
  user?: {
    name?: string;
    email?: string;
  };
  onLogout: () => void;
}

export default function Dashboard({
  user,
  onLogout,
}: DashboardProps): React.ReactElement {
  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="header-content">
          <div className="logo-section">
            <img width="40" alt="Checkpoint Logo" src={icon} />
            <h1>Checkpoint</h1>
          </div>
          <div className="user-section">
            <span className="welcome-text">
              Welcome back{user?.name ? `, ${user.name}` : ""}!
            </span>
            <button type="button" onClick={onLogout} className="logout-button">
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <main className="dashboard-main">
        <div className="dashboard-content">
          <div className="welcome-card">
            <h2>You're all set!</h2>
            <p>
              You have successfully authenticated with Checkpoint. The desktop
              application is ready to use.
            </p>
          </div>

          <div className="features-grid">
            <div className="feature-card">
              <div className="feature-icon">🚀</div>
              <h3>Fast Sync</h3>
              <p>Efficient synchronization of large files</p>
            </div>

            <div className="feature-card">
              <div className="feature-icon">🔒</div>
              <h3>Secure</h3>
              <p>Enterprise-grade security for your data</p>
            </div>

            <div className="feature-card">
              <div className="feature-icon">📁</div>
              <h3>Version Control</h3>
              <p>Track changes across all your projects</p>
            </div>

            <div className="feature-card">
              <div className="feature-icon">👥</div>
              <h3>Collaboration</h3>
              <p>Work together seamlessly with your team</p>
            </div>
          </div>

          <div className="action-section">
            <p>Ready to get started?</p>
            <div className="action-buttons">
              <button type="button" className="primary-button">
                Open Repository
              </button>
              <button type="button" className="secondary-button">
                Create New Project
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
