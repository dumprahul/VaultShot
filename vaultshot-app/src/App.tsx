import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './index.css'
import DepositPage from './DepositPage'
import VaultShot from './VaultShot'
import ProfilePage from './ProfilePage'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<VaultShot />} />
        <Route path="/deposit" element={<DepositPage />} />
        <Route path="/profile" element={<ProfilePage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
