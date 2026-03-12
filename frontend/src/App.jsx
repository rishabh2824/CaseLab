import { Navigate, Route, Routes } from 'react-router-dom'
import Case from './case.jsx'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/newCase" replace />} />
      <Route path="/newCase" element={<Case />} />
    </Routes>
  )
}

export default App
